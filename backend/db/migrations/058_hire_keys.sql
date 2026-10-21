-- Hiring keys let a client's own AI agent find, quote, and propose Super Agent work over MCP.
-- A key never approves or funds: its proposals wait in the client's Requests like any other.
CREATE TABLE hire_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  token_hash text UNIQUE NOT NULL,
  max_budget_per_hire numeric(30,18) NOT NULL CHECK (max_budget_per_hire > 0),
  daily_budget numeric(30,18) NOT NULL CHECK (daily_budget >= max_budget_per_hire),
  revoked_at timestamptz,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hire_keys_user_idx ON hire_keys (user_id, created_at DESC);

ALTER TABLE superagent_intents
  ADD COLUMN hire_key_id uuid REFERENCES hire_keys(id) ON DELETE SET NULL,
  DROP CONSTRAINT superagent_intents_source_check,
  ADD CONSTRAINT superagent_intents_source_check CHECK (source IN ('x','dashboard','cli','mcp'));
CREATE INDEX superagent_intents_hire_key_idx ON superagent_intents (hire_key_id, created_at DESC)
  WHERE hire_key_id IS NOT NULL;
