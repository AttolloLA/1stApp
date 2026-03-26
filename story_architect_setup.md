# Story Architect — n8n Setup Guide

## Overview
This workflow powers a multi-turn Telegram bot that interviews Zinzino reps and generates a complete 3-piece content pack using Claude AI. Each Telegram message triggers the workflow; conversation history is stored in Supabase.

---

## Step 1 — Run the SQL in Supabase

Open the **Supabase SQL Editor** for your project and run the following two queries.

### 1a — Ensure the sessions table exists (run only if missing)
```sql
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID REFERENCES reps(id),
  telegram_id BIGINT NOT NULL,
  messages JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'complete')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for fast session lookups
CREATE INDEX IF NOT EXISTS idx_sessions_telegram_status
  ON sessions(telegram_id, status, created_at DESC);
```

### 1b — Create the atomic credit decrement function (REQUIRED)
```sql
CREATE OR REPLACE FUNCTION decrement_rep_credits(p_telegram_id BIGINT)
RETURNS void AS $$
  UPDATE reps
  SET credits = credits - 1
  WHERE telegram_id = p_telegram_id
    AND credits > 0;
$$ LANGUAGE sql SECURITY DEFINER;
```

> **Why an RPC function?** This ensures the credit deduction is atomic — it will never decrement below 0, even under concurrent requests.

---

## Step 2 — Import the Workflow into n8n

1. Open your n8n instance
2. Click **Workflows** in the left sidebar
3. Click **Add workflow → Import from file**
4. Select `story_architect_workflow.json`
5. Click **Import**

The workflow will appear as **inactive** (safe — it won't run until you activate it).

---

## Step 3 — Replace the 3 Placeholder Values

> Search for these strings in each node and replace them. There are **multiple occurrences** of the Supabase values.

### `YOUR_SUPABASE_URL`
Your Supabase project URL, e.g. `https://rjwazjmmyjqzgvnarnoj.supabase.co`

Replace in these nodes:
- **Check Active Session** → URL field
- **Check Rep** → URL field
- **Prep Upsert** → inside the JavaScript code (2 occurrences — POST and PATCH URLs)
- **Save Story** → URL field
- **Deduct Credits** → URL field
- **Log Usage** → URL field

### `YOUR_SUPABASE_KEY`
Your Supabase **secret key** (starts with `sb_secret_...`). Find it in: Supabase → Project Settings → API → `service_role` key.

> ⚠️ Use the **service_role** key (not the anon key) — it bypasses Row Level Security for server-side operations.

Replace in these nodes:
- **Check Active Session** → both `apikey` and `Authorization Bearer` headers
- **Check Rep** → both headers
- **Upsert Session** → both headers
- **Save Story** → both headers
- **Deduct Credits** → both headers
- **Log Usage** → both headers

### `YOUR_ANTHROPIC_KEY`
Your Anthropic API key (starts with `sk-ant-...`). Find it at console.anthropic.com → API Keys.

Replace in:
- **Call Claude** → `x-api-key` header value

---

## Step 4 — Verify the Telegram Credential

1. In n8n, go to **Credentials**
2. Confirm a credential named **"Telegram API"** exists
3. If not: create one → Type: Telegram API → paste your bot token
4. Back in the workflow, click the **Telegram Trigger** node and confirm it references "Telegram API"
5. Do the same for **Send Error** and **Send Telegram Message** nodes

---

## Step 5 — Activate and Test End-to-End

### Activate the workflow
Toggle the workflow to **Active** using the switch in the top-right of the workflow editor.

### Test path 1 — Unregistered user (error handling)
1. Open Telegram and message your bot: `/story`
2. Expected: bot replies "You're not registered in RepFlowAI yet..."

### Test path 2 — Registered rep, full conversation
1. Make sure a rep exists in your `reps` table with `manifesto_accepted = true` and `credits >= 1`
2. Message the bot: `/story`
3. Expected: warm welcome message from the Story Architect
4. Continue the conversation — answer each question
5. After all steps, Claude will deliver the 3-piece content pack
6. Check Supabase: `sessions` row should show `status = 'complete'`, `stories` table should have the new story, `credits` should be decremented by 1, `usage_logs` should show a new entry

### Test path 3 — Continue an existing session
1. Start a `/story` session but don't finish it
2. Close and reopen Telegram
3. Send any message (not `/story`)
4. Expected: bot continues the conversation from where you left off

---

## Architecture Notes

### Why HTTP Request instead of the built-in Anthropic node?
The built-in Anthropic n8n node has a known bug in the test/manual execution environment. Using a plain HTTP Request node is more reliable and gives you full control over headers and body.

### Why a Supabase RPC for credits?
A direct PATCH to `reps.credits = credits - 1` is not atomic in REST API mode. The RPC function (`decrement_rep_credits`) runs server-side and is safe under concurrent requests.

### Session continuation logic
The `Route Logic` code node checks for an active (in_progress) session for the user's Telegram ID. If found, it continues. If not, it only starts a new session if the user sent `/story`. All other messages are silently ignored — this prevents accidental triggers.

### The [POST_READY] signal
Claude is instructed to append `[POST_READY]` on its own line when it delivers the final content pack. The `Parse Claude Response` code node detects this, strips it from the user-facing message, and triggers the completion path (save story, deduct credits, log usage).

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Bot doesn't respond at all | Webhook not registered | Make sure the workflow is Active; check the Telegram Trigger node for a valid webhook URL |
| "Not registered" error for a valid rep | Wrong Supabase URL or key | Check the `Check Rep` node URL and headers |
| Claude doesn't respond | Wrong Anthropic key | Check `Call Claude` node `x-api-key` header |
| Session not saving | Supabase key lacks write access | Use the `service_role` key, not `anon` |
| Credits not deducting | `decrement_rep_credits` function not created | Run Step 1b SQL again |
| Messages pile up / bot loops | `[POST_READY]` tag not appearing in Claude response | Verify the system prompt in `Call Claude` is complete and ends with the CRITICAL note |
