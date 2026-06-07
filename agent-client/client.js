require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const execFileAsync = promisify(execFile);

const AGENT_NAME   = process.env.AGENT_NAME;
const POLL_MS      = 2000;
const KNOWN_AGENTS = ['clem', 'hermes', 'jarvis'];
const BUCKET       = 'agent-transfers';
const DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads');

if (!AGENT_NAME) { console.error('AGENT_NAME is required'); process.exit(1); }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const agentApi = new OpenAI({
  baseURL: `http://localhost:${process.env.AGENT_PORT || process.env.HERMES_PORT || 8642}/v1`,
  apiKey:  process.env.AGENT_API_KEY || process.env.HERMES_API_KEY || 'unused',
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function expandPath(p) {
  return path.resolve(p.replace(/^~/, os.homedir()));
}

// Parse [TRANSFER: /path/to/file → agentname] signals from response text
function extractTransferSignals(text) {
  const regex = /\[TRANSFER:\s*(.+?)\s*(?:→|->)\s*(\w+)\s*\]/gi;
  const results = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const toAgent = match[2].trim().toLowerCase();
    if (KNOWN_AGENTS.includes(toAgent) && toAgent !== AGENT_NAME) {
      results.push({ filePath: match[1].trim(), toAgent });
    }
  }
  return results;
}

// Strip all control signals from text before displaying
function stripSignals(text) {
  return text
    .replace(/\[(DONE|CONTINUE)\]/gi, '')
    .replace(/\[TRANSFER:\s*.+?\]/gi, '')
    .trim();
}

async function uploadFile(filePath, conversationId) {
  const resolved = expandPath(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const filename    = path.basename(resolved);
  const fileBuffer  = fs.readFileSync(resolved);
  const storagePath = `${conversationId}/${Date.now()}-${filename}`;
  const mimeType    = guessMime(filename);

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, { contentType: mimeType });

  if (error) throw error;
  return { storagePath, filename, size: fileBuffer.length, mimeType };
}

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.zip': 'application/zip', '.md': 'text/markdown',
    '.js': 'text/javascript', '.ts': 'text/typescript', '.html': 'text/html',
  };
  return map[ext] || 'application/octet-stream';
}

// ── Agent call (Hermes or OpenClaw) ──────────────────────────────────────────

async function callAgent(messages) {
  if ((process.env.AGENT_TYPE || '').toLowerCase() === 'openclaw') {
    const text = messages
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');

    const bin     = process.env.OPENCLAW_BIN  || 'openclaw';
    const agentId = process.env.OPENCLAW_AGENT_ID || 'main';
    const user    = process.env.OPENCLAW_USER;

    const [cmd, args] = user
      ? ['sudo', ['-u', user, bin, 'agent', '--agent', agentId, '--message', text, '--json']]
      : [bin,    ['agent', '--agent', agentId, '--message', text, '--json']];

    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const data = JSON.parse(stdout);
    if (data.status !== 'ok') throw new Error(`openclaw status=${data.status}: ${data.summary || 'unknown'}`);
    return data.result?.payloads?.[0]?.text ?? '';
  }

  const response = await agentApi.chat.completions.create({
    model: process.env.AGENT_MODEL || 'hermes-agent',
    messages,
  });
  return response.choices[0].message.content;
}

// ── Task processing ───────────────────────────────────────────────────────────

async function processTask(task) {
  await supabase.from('tasks')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', task.id);

  try {
    const raw = await callAgent(task.payload.messages);
    const isDone     = /\[DONE\]/i.test(raw);
    const isContinue = /\[CONTINUE\]/i.test(raw);
    const transfers  = extractTransferSignals(raw);
    const result     = stripSignals(raw);

    // Save visible message
    const { data: savedMsg } = await supabase.from('messages').insert({
      conversation_id: task.conversation_id,
      from_agent: AGENT_NAME,
      body: result,
      role: 'assistant',
    }).select().single();

    await supabase.from('tasks')
      .update({ status: 'done', result, updated_at: new Date().toISOString() })
      .eq('id', task.id);

    // Handle file transfers
    for (const { filePath, toAgent } of transfers) {
      try {
        const { storagePath, filename, size, mimeType } = await uploadFile(filePath, task.conversation_id);
        await supabase.from('transfers').insert({
          message_id:  savedMsg?.id ?? null,
          from_agent:  AGENT_NAME,
          to_agent:    toAgent,
          type:        'file',
          storage_url: storagePath,
          filename,
          mime_type:   mimeType,
          size_bytes:  size,
          status:      'pending',
        });
        console.log(`[${AGENT_NAME}] uploaded "${filename}" (${size} bytes) → @${toAgent}`);
      } catch (err) {
        console.error(`[${AGENT_NAME}] upload failed for "${filePath}":`, err.message);
      }
    }

    // Agent-to-agent conversation routing
    const hasAtMention = KNOWN_AGENTS.filter(a => a !== AGENT_NAME)
      .some(a => new RegExp(`@${a}`, 'i').test(result));
    const shouldForward = (isContinue || hasAtMention) && task.turn_number < task.max_turns - 1;

    if (shouldForward) {
      const otherAgents = KNOWN_AGENTS.filter(a => a !== AGENT_NAME);
      const target = otherAgents.find(a => new RegExp(`@${a}`, 'i').test(result)) || otherAgents[0];
      const { data: history } = await supabase
        .from('messages').select('role, body')
        .eq('conversation_id', task.conversation_id).order('created_at');

      await supabase.from('tasks').insert({
        conversation_id: task.conversation_id,
        assigned_to:     target,
        turn_number:     task.turn_number + 1,
        max_turns:       task.max_turns,
        payload:         { messages: buildMessages(history || [], target) },
      });
      console.log(`[${AGENT_NAME}] → @${target} (turn ${task.turn_number + 1}/${task.max_turns})`);
    } else {
      console.log(`[${AGENT_NAME}] done (turn ${task.turn_number}, signal: ${isDone ? '[DONE]' : 'no forward'})`);
    }

  } catch (err) {
    console.error(`[${AGENT_NAME}] task failed:`, err.message);
    await supabase.from('tasks')
      .update({ status: 'failed', error: err.message, updated_at: new Date().toISOString() })
      .eq('id', task.id);
  }
}

function buildMessages(history, targetAgent) {
  const others = KNOWN_AGENTS.filter(a => a !== targetAgent).join(', ');
  const systemPrompt = {
    role: 'user',
    content:
      `You are ${targetAgent}, an AI assistant. Other agents: ${others}.\n` +
      `To send a file: [TRANSFER: /full/path/to/file → agentname]\n` +
      `Important: if you @mention another agent in your response, they will automatically receive your message and can reply.\n` +
      `End your response with [DONE] when the conversation should stop — otherwise it continues.\n` +
      `Use [DONE] when: you have fully answered the user, or the exchange is complete. Be concise.`,
  };
  return [systemPrompt, ...history.map(m => ({ role: m.role, content: m.body }))];
}

// ── Transfer poller ───────────────────────────────────────────────────────────

async function pollTransfers() {
  const { data: pending } = await supabase
    .from('transfers')
    .select('*')
    .eq('to_agent', AGENT_NAME)
    .eq('status', 'pending');

  if (!pending?.length) return;

  for (const transfer of pending) {
    try {
      const { data: fileData, error } = await supabase.storage
        .from(BUCKET)
        .download(transfer.storage_url);

      if (error) throw error;

      const destPath = path.join(DOWNLOAD_DIR, transfer.filename);
      const buffer   = Buffer.from(await fileData.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      await supabase.from('transfers')
        .update({ status: 'delivered' })
        .eq('id', transfer.id);

      // Find the conversation and post a delivery confirmation
      if (transfer.message_id) {
        const { data: msg } = await supabase.from('messages')
          .select('conversation_id').eq('id', transfer.message_id).single();
        if (msg) {
          await supabase.from('messages').insert({
            conversation_id: msg.conversation_id,
            from_agent: AGENT_NAME,
            body: `Received "${transfer.filename}" from @${transfer.from_agent} — saved to ~/Downloads/${transfer.filename}`,
            role: 'assistant',
          });
        }
      }

      console.log(`[${AGENT_NAME}] received "${transfer.filename}" from @${transfer.from_agent}`);
    } catch (err) {
      console.error(`[${AGENT_NAME}] transfer download failed:`, err.message);
      await supabase.from('transfers').update({ status: 'failed' }).eq('id', transfer.id);
    }
  }
}

// ── Task poller ───────────────────────────────────────────────────────────────

async function pollTasks() {
  const { data: tasks, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('assigned_to', AGENT_NAME)
    .eq('status', 'pending')
    .order('created_at')
    .limit(1);

  if (error) { console.error('poll error:', error.message); return; }
  if (!tasks?.length) return;

  console.log(`[${AGENT_NAME}] picked up task ${tasks[0].id}`);
  await processTask(tasks[0]);
}

async function heartbeat() {
  await supabase.from('agents')
    .update({ status: 'online', last_seen: new Date().toISOString() })
    .eq('name', AGENT_NAME);
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown() {
  await supabase.from('agents').update({ status: 'offline' }).eq('name', AGENT_NAME);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ── Start ─────────────────────────────────────────────────────────────────────

(async () => {
  await heartbeat();
  console.log(`[${AGENT_NAME}] started — polling every ${POLL_MS}ms`);
  setInterval(heartbeat,      30_000);
  setInterval(pollTasks,      POLL_MS);
  setInterval(pollTransfers,  POLL_MS);
  pollTasks();
  pollTransfers();
})();
