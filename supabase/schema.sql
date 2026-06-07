-- hermes-orchestrator schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE agents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,
  machine     TEXT,
  status      TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'busy')),
  last_seen   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO agents (name, machine) VALUES
  ('clem',   'M1 MacBook Air'),
  ('hermes', 'M3 MacBook');

CREATE TABLE conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  from_agent       TEXT,   -- null = from user
  to_agent         TEXT,   -- null = to user
  body             TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assigned_to      TEXT NOT NULL,
  status           TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done', 'failed')),
  turn_number      INT DEFAULT 0,
  max_turns        INT DEFAULT 8,
  payload          JSONB NOT NULL,
  result           TEXT,
  error            TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE transfers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID REFERENCES messages(id),
  from_agent  TEXT,
  to_agent    TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('file', 'text', 'table', 'image', 'clipboard')),
  content     TEXT,
  storage_url TEXT,
  mime_type   TEXT,
  filename    TEXT,
  size_bytes  INT,
  status      TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_messages_conv     ON messages(conversation_id, created_at);
CREATE INDEX idx_tasks_agent       ON tasks(assigned_to, status, created_at);
CREATE INDEX idx_transfers_to      ON transfers(to_agent, status);

-- RLS: allow all via service role key (server-side only)
ALTER TABLE agents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks         ENABLE ROW LEVEL SECURITY;
ALTER TABLE transfers     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_agents"        ON agents        FOR ALL USING (true);
CREATE POLICY "all_conversations" ON conversations FOR ALL USING (true);
CREATE POLICY "all_messages"      ON messages      FOR ALL USING (true);
CREATE POLICY "all_tasks"         ON tasks         FOR ALL USING (true);
CREATE POLICY "all_transfers"     ON transfers     FOR ALL USING (true);
