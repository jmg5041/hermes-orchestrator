import { createClient } from '@/lib/supabase-server';
import { NextResponse } from 'next/server';

const KNOWN_AGENTS = ['clem', 'hermes', 'jarvis'];

export async function POST(req: Request) {
  const { message, conversationId } = await req.json();

  if (!message?.trim() || !conversationId) {
    return NextResponse.json({ error: 'message and conversationId required' }, { status: 400 });
  }

  const supabase = createClient();

  // Save user message
  await supabase.from('messages').insert({
    conversation_id: conversationId,
    body: message.trim(),
    role: 'user',
  });

  // Parse @mentions to find target agents
  const mentions = (message.match(/@(\w+)/gi) ?? [])
    .map((m: string) => m.slice(1).toLowerCase())
    .filter((m: string) => KNOWN_AGENTS.includes(m));

  const targets = mentions.length > 0 ? [mentions[0]] : ['clem'];

  // Fetch conversation history for task payload
  const { data: history } = await supabase
    .from('messages')
    .select('role, body')
    .eq('conversation_id', conversationId)
    .order('created_at');

  const historyMessages = (history ?? []).map(m => ({ role: m.role, content: m.body }));

  // Create a task for each target agent
  for (const target of targets) {
    const systemPrompt = {
      role: 'user' as const,
      content:
        `You are ${target}, an AI assistant. Other agents: ${KNOWN_AGENTS.filter(a => a !== target).join(', ')}.\n` +
        `To send a file: [TRANSFER: /full/path/to/file → agentname]\n` +
        `Important: if you @mention another agent in your response, they will automatically receive your message and can reply.\n` +
        `End your response with [DONE] when the conversation should stop — otherwise it continues.\n` +
        `Use [DONE] when: you have fully answered the user, or the exchange is complete. Be concise.`,
    };

    await supabase.from('tasks').insert({
      conversation_id: conversationId,
      assigned_to:     target,
      turn_number:     0,
      max_turns:       8,
      payload:         { messages: [systemPrompt, ...historyMessages] },
    });
  }

  return NextResponse.json({ ok: true, targets });
}
