require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const AGENT_NAME   = process.env.AGENT_NAME;
const POLL_MS      = 2000;
const KNOWN_AGENTS = ['clem', 'hermes'];

if (!AGENT_NAME) { console.error('AGENT_NAME is required'); process.exit(1); }

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const hermes = new OpenAI({
  baseURL: `http://localhost:${process.env.HERMES_PORT || 8642}/v1`,
  apiKey:  process.env.HERMES_API_KEY,
});

async function heartbeat() {
  await supabase.from('agents')
    .update({ status: 'online', last_seen: new Date().toISOString() })
    .eq('name', AGENT_NAME);
}

async function processTask(task) {
  // Mark in progress
  await supabase.from('tasks')
    .update({ status: 'in_progress', updated_at: new Date().toISOString() })
    .eq('id', task.id);

  try {
    const response = await hermes.chat.completions.create({
      model: 'hermes-agent',
      messages: task.payload.messages,
    });

    const raw = response.choices[0].message.content;

    // Strip [CONTINUE] / [DONE] signals before displaying
    const isDone     = /\[DONE\]/i.test(raw);
    const isContinue = /\[CONTINUE\]/i.test(raw);
    const result     = raw.replace(/\[(DONE|CONTINUE)\]/gi, '').trim();

    // Save agent response as a message (without the signal)
    await supabase.from('messages').insert({
      conversation_id: task.conversation_id,
      from_agent: AGENT_NAME,
      body: result,
      role: 'assistant',
    });

    // Mark task done
    await supabase.from('tasks')
      .update({ status: 'done', result, updated_at: new Date().toISOString() })
      .eq('id', task.id);

    // Route to another agent if:
    //   - [CONTINUE] signal present, OR an @mention exists
    //   - AND not explicitly [DONE]
    //   - AND under turn limit
    const hasAtMention = KNOWN_AGENTS.filter(a => a !== AGENT_NAME)
      .some(a => new RegExp(`@${a}`, 'i').test(result));

    const shouldForward = !isDone && (isContinue || hasAtMention) && task.turn_number < task.max_turns - 1;

    if (shouldForward) {
      // Find the target — prefer @mention, otherwise the other agent
      const otherAgents = KNOWN_AGENTS.filter(a => a !== AGENT_NAME);
      const target = otherAgents.find(a => new RegExp(`@${a}`, 'i').test(result)) || otherAgents[0];

      const { data: history } = await supabase
        .from('messages')
        .select('role, body')
        .eq('conversation_id', task.conversation_id)
        .order('created_at');

      await supabase.from('tasks').insert({
        conversation_id: task.conversation_id,
        assigned_to:     target,
        turn_number:     task.turn_number + 1,
        max_turns:       task.max_turns,
        payload:         { messages: buildMessages(history || [], target) },
      });

      console.log(`[${AGENT_NAME}] → @${target} (turn ${task.turn_number + 1}/${task.max_turns}, signal: ${isContinue ? '[CONTINUE]' : '@mention'})`);
    } else {
      console.log(`[${AGENT_NAME}] conversation ended (${isDone ? '[DONE]' : 'no forward signal'}, turn ${task.turn_number})`);
    }

  } catch (err) {
    console.error(`[${AGENT_NAME}] task failed:`, err.message);
    await supabase.from('tasks')
      .update({ status: 'failed', error: err.message, updated_at: new Date().toISOString() })
      .eq('id', task.id);
  }
}

function buildMessages(history, targetAgent) {
  const systemPrompt = {
    role: 'user',
    content:
      `You are ${targetAgent}, an AI assistant running on a Mac. ` +
      `You are part of a multi-agent system with the following agents: ${KNOWN_AGENTS.join(', ')}. ` +
      `To pass work to another agent, include @agentname anywhere in your response. ` +
      `End every response with exactly one of these signals on its own line:\n` +
      `[CONTINUE] — you want the other agent to respond (keeps the conversation going)\n` +
      `[DONE] — the task or conversation is finished\n` +
      `Use [DONE] by default unless there is a clear reason to keep going. ` +
      `Be direct — no sign-off phrases.`,
  };
  return [systemPrompt, ...history.map(m => ({ role: m.role, content: m.body }))];
}

async function poll() {
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

// Graceful shutdown
async function shutdown() {
  await supabase.from('agents').update({ status: 'offline' }).eq('name', AGENT_NAME);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// Start
(async () => {
  await heartbeat();
  console.log(`[${AGENT_NAME}] agent client started, polling every ${POLL_MS}ms`);
  setInterval(heartbeat, 30_000);
  setInterval(poll, POLL_MS);
  poll();
})();
