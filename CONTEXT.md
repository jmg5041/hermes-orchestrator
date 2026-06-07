# Hermes Orchestrator — Project Context

Multi-agent system connecting two Hermes AI agents (Nous Research) so they can
converse, hand off tasks, and share files — without falling into infinite response loops.

## Why this exists

Running two Hermes agents in the same Discord channel caused a politeness death spiral:
each bot would say "I'll stop now" and the other would respond "me too" — forever.
The fix: neither agent talks to the other directly. All routing goes through a central
orchestrator that controls when and whether to forward messages.

## Architecture

```
You (browser) → Vercel Next.js web UI
                    ↓
              Vercel API routes  (orchestrator logic)
                    ↓
              Supabase  (job queue + message log + file storage)
                    ↓
     ┌──────────────┴──────────────┐
     ↓                             ↓
Clem agent client            Hermes agent client
(polls Supabase every 2s)    (polls Supabase every 2s)
calls localhost:8642          calls localhost:8642
(Hermes gateway on M1)        (Hermes gateway on M3)
```

Neither agent client is exposed to the internet. They reach out to Supabase; nothing
reaches in to them. All machines are connected via Tailscale.

## Machines

| Name   | Machine        | Tailscale IP    | Role           |
|--------|---------------|-----------------|----------------|
| Clem   | M1 MacBook Air | 100.64.149.22  | Agent + client |
| Hermes | M3 MacBook     | 100.114.61.106 | Agent + client |
| jarvis-vps | Hostinger VPS | 100.100.223.8 | Future: run both clients persistently |

## Services

- **Vercel project:** hermes-orchestrator (root dir: `web/`)
- **Supabase project:** pqmcyadumwabrugiecjh.supabase.co
- **Supabase Storage bucket:** `agent-transfers` (file transfers between agents)
- **GitHub repo:** jmg5041/hermes-orchestrator (private)

## How agents communicate

1. You type a message in the web UI, optionally with `@clem` or `@hermes`
2. Vercel API route saves message + creates a task in Supabase
3. The addressed agent's client picks up the task, calls its local Hermes gateway
4. Response is saved to Supabase messages table
5. If the response contains `[CONTINUE]` or `@otheragent`, the client creates a new
   task for the other agent (up to `max_turns`, default 8)
6. If the response contains `[DONE]`, the chain stops

## File transfers

Agents include a transfer signal in their response:
```
[TRANSFER: /full/path/to/file → agentname]
```
The sending agent's client uploads the file to Supabase Storage (`agent-transfers` bucket).
The receiving agent's client polls for pending transfers, downloads to `~/Downloads/`,
posts a confirmation message in the chat.

## Loop prevention signals

Every agent response must end with one of:
- `[CONTINUE]` — keep the conversation going, route to the other agent
- `[DONE]` — stop here

These are stripped before displaying in the UI.

## Directory structure

```
hermes-orchestrator/
  agent-client/
    client.js          # Node.js poller — runs on each Mac
    package.json
    .env.example       # Copy to .env, fill in values
  supabase/
    schema.sql         # Run this in Supabase SQL editor to set up tables
  web/
    app/
      page.tsx         # Chat UI
      api/chat/        # Message routing + task creation
      api/agents/      # Agent status endpoint
      api/conversations/
    lib/
      supabase-browser.ts
      supabase-server.ts
      types.ts
```

## Environment variables

**agent-client/.env** (on each Mac):
```
AGENT_NAME=clem          # or hermes
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=... # service role key (secret)
HERMES_API_KEY=...       # must match API_SERVER_KEY in ~/.hermes/.env
HERMES_PORT=8642
```

**web/.env.local** (and Vercel env vars):
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_KEY=...
```

**~/.hermes/.env** (on each Mac, to enable the API server):
```
API_SERVER_ENABLED=true
API_SERVER_HOST=0.0.0.0
API_SERVER_PORT=8642
API_SERVER_KEY=...       # must match HERMES_API_KEY in agent-client/.env
```

## Running the agent client

```bash
cd ~/Developer/hermes-orchestrator/agent-client
npm install
node client.js
```

Both Macs have launchd services set up for auto-start:
- Clem: `ai.clem.agent-client` (`~/Library/LaunchAgents/ai.clem.agent-client.plist`)
- Hermes: `ai.hermes.agent-client`

Useful commands:
```bash
launchctl stop ai.clem.agent-client
launchctl start ai.clem.agent-client
tail -f ~/.hermes/logs/agent-client.log
```

## Next steps

- [ ] Wake jarvis-vps (Hostinger), install Node.js, run both agent clients with `pm2`
- [ ] Add drag-and-drop file upload in the web UI
- [ ] Add more agents (insert row in `agents` table, run client with new AGENT_NAME)
- [ ] Give the Vercel deployment a custom domain
