'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import type { Agent, Conversation, Message } from '@/lib/types';

const AGENT_COLORS: Record<string, string> = {
  clem:   'text-purple-400',
  hermes: 'text-cyan-400',
};

export default function Home() {
  const [agents, setAgents]               = useState<Agent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId]   = useState<string | null>(null);
  const [messages, setMessages]           = useState<Message[]>([]);
  const [pendingTasks, setPendingTasks]   = useState(0);
  const [input, setInput]                 = useState('');
  const [sending, setSending]             = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const supabase  = createClient();

  // Load agents
  useEffect(() => {
    supabase.from('agents').select('*').then(({ data }) => setAgents(data ?? []));

    const ch = supabase.channel('agents-watch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agents' }, ({ new: row }) => {
        setAgents(prev => {
          const filtered = prev.filter(a => a.id !== (row as Agent).id);
          return [...filtered, row as Agent].sort((a, b) => a.name.localeCompare(b.name));
        });
      })
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, []);

  // Load conversations and auto-select latest
  useEffect(() => {
    supabase.from('conversations').select('*').order('created_at', { ascending: false })
      .then(({ data }) => {
        setConversations(data ?? []);
        if (data?.length && !activeConvId) setActiveConvId(data[0].id);
      });
  }, []);

  // Load messages when conversation changes
  useEffect(() => {
    if (!activeConvId) return;
    setMessages([]);

    supabase.from('messages').select('*')
      .eq('conversation_id', activeConvId)
      .order('created_at')
      .then(({ data }) => {
        setMessages(data ?? []);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      });
  }, [activeConvId]);

  // Realtime: new messages
  useEffect(() => {
    if (!activeConvId) return;

    const ch = supabase.channel(`messages-${activeConvId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${activeConvId}`,
      }, ({ new: row }) => {
        setMessages(prev => {
          if (prev.find(m => m.id === (row as Message).id)) return prev;
          return [...prev, row as Message];
        });
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      })
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [activeConvId]);

  // Realtime: pending task count for spinner
  useEffect(() => {
    if (!activeConvId) return;

    const ch = supabase.channel(`tasks-${activeConvId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'tasks',
        filter: `conversation_id=eq.${activeConvId}`,
      }, () => {
        supabase.from('tasks')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', activeConvId)
          .in('status', ['pending', 'in_progress'])
          .then(({ count }) => setPendingTasks(count ?? 0));
      })
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [activeConvId]);

  const newConversation = useCallback(async () => {
    const { data } = await supabase.from('conversations')
      .insert({ title: new Date().toLocaleString() })
      .select().single();
    if (data) {
      setConversations(prev => [data, ...prev]);
      setActiveConvId(data.id);
    }
  }, []);

  const send = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !activeConvId || sending) return;

    const text = input.trim();
    setInput('');
    setSending(true);

    // Optimistically show the user message immediately
    const optimistic: Message = {
      id: `optimistic-${Date.now()}`,
      conversation_id: activeConvId,
      from_agent: null,
      to_agent: null,
      body: text,
      role: 'user',
      created_at: new Date().toISOString(),
    };
    setMessages(prev => [...prev, optimistic]);
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId: activeConvId }),
    });

    setSending(false);

    // Poll for new messages every 2s for up to 30s as fallback if Realtime isn't firing
    let polls = 0;
    const poll = setInterval(async () => {
      polls++;
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', activeConvId)
        .order('created_at');
      if (data) {
        setMessages(data);
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
      }
      if (polls >= 15) clearInterval(poll);
    }, 2000);
  }, [input, activeConvId, sending]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left sidebar */}
      <aside className="w-52 flex flex-col border-r border-gray-800 bg-gray-900 shrink-0">
        <div className="p-3 border-b border-gray-800">
          <h1 className="text-sm font-semibold text-gray-200">Hermes Orchestrator</h1>
        </div>

        {/* Agents */}
        <div className="p-3 border-b border-gray-800">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">Agents</p>
          {agents.map(a => (
            <div key={a.id} className="flex items-center gap-2 py-1">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                a.status === 'online' ? 'bg-green-400' :
                a.status === 'busy'   ? 'bg-yellow-400' : 'bg-gray-600'
              }`} />
              <span className={`text-sm font-medium capitalize ${AGENT_COLORS[a.name] ?? 'text-gray-300'}`}>
                {a.name}
              </span>
              <span className="text-xs text-gray-600 truncate">{a.machine}</span>
            </div>
          ))}
        </div>

        {/* Conversations */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500 uppercase tracking-wider">Chats</p>
            <button onClick={newConversation}
              className="text-xs text-gray-400 hover:text-white transition-colors">+ New</button>
          </div>
          {conversations.map(c => (
            <button key={c.id} onClick={() => setActiveConvId(c.id)}
              className={`w-full text-left px-2 py-1.5 rounded text-xs truncate transition-colors ${
                c.id === activeConvId
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}>
              {c.title ?? 'Untitled'}
            </button>
          ))}
        </div>
      </aside>

      {/* Main chat */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeConvId ? (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${!msg.from_agent ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-2xl rounded-xl px-4 py-3 ${
                    !msg.from_agent
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-100'
                  }`}>
                    {msg.from_agent && (
                      <p className={`text-xs font-semibold mb-1 capitalize ${
                        AGENT_COLORS[msg.from_agent] ?? 'text-gray-400'
                      }`}>
                        {msg.from_agent}
                      </p>
                    )}
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.body}</p>
                  </div>
                </div>
              ))}

              {pendingTasks > 0 && (
                <div className="flex justify-start">
                  <div className="bg-gray-800 rounded-xl px-4 py-3">
                    <div className="flex items-center gap-2 text-gray-400 text-sm">
                      <span className="flex gap-1">
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]" />
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]" />
                        <span className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]" />
                      </span>
                      thinking...
                    </div>
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <form onSubmit={send} className="border-t border-gray-800 bg-gray-900 p-4">
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  placeholder="Message @clem or @hermes..."
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm
                             placeholder-gray-500 outline-none focus:border-blue-500 transition-colors"
                  disabled={sending}
                />
                <button type="submit"
                  disabled={sending || !input.trim()}
                  className="px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40
                             rounded-lg text-sm font-medium transition-colors">
                  Send
                </button>
              </div>
              <p className="text-xs text-gray-600 mt-1.5">
                @clem routes to M1 · @hermes routes to M3 · no @mention defaults to @clem
              </p>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <button onClick={newConversation}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition-colors">
              Start a conversation
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
