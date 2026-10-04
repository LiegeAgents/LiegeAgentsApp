CREATE TABLE IF NOT EXISTS runtime_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  agent_ids uuid[] NOT NULL DEFAULT '{}',
  scopes text[] NOT NULL DEFAULT '{jobs:read,briefs:read,deliverables:write}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS runtime_tokens_owner_idx ON runtime_tokens (owner_id, created_at DESC);
