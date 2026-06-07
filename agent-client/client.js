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

    const result = response.choices[0].message.content;

    // Save agent response as a message
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

    // Agent-to-agent routing: check if response mentions another agent
    if (task.turn_number < task.max_turns - 1) {
      const otherAgents = KNOWN_AGENTS.filter(a => a !== AGENT_NAME);
      for (const target of otherAgents) {
        if (new RegExp(`@${target}`, 'i').test(result)) {
          // Fetch full conversation history to pass as context
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

          console.log(`[${AGENT_NAME}] routed to @${target} (turn ${task.turn_number + 1}/${task.max_turns})`);
          break; // only one forward per turn
        }
      }
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
    content: `You are ${targetAgent}, an AI assistant running on a Mac. ` +
      `You are part of a multi-agent system with the following agents: ${KNOWN_AGENTS.join(', ')}. ` +
      `To hand work to another agent, include @agentname in your response. ` +
      `Complete your task directly — do not add sign-off phrases like "I'll stop here" or "let me know if you need anything".`,
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
