-- Agent memory: what an agent should remember about a client across jobs. The client writes
-- preferences; past revision feedback with that agent is read from job_revisions. The client
-- can turn memory off per agent or clear it, which hides everything before that moment.
CREATE TABLE agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  preferences_ciphertext text,
  cleared_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, agent_id)
);
