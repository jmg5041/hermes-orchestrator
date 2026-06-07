export type AgentStatus = 'online' | 'offline' | 'busy';

export interface Agent {
  id: string;
  name: string;
  machine: string | null;
  status: AgentStatus;
  last_seen: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  from_agent: string | null;
  to_agent: string | null;
  body: string;
  role: 'user' | 'assistant';
  created_at: string;
}

export interface Task {
  id: string;
  conversation_id: string;
  assigned_to: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  turn_number: number;
  max_turns: number;
  payload: { messages: { role: string; content: string }[] };
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}
