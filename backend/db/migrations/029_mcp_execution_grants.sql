CREATE TABLE mcp_execution_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL UNIQUE REFERENCES mcp_proposals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  deliverable_digest text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_execution_grants_job_idx ON mcp_execution_grants (job_id);
CREATE INDEX mcp_execution_grants_expiry_idx ON mcp_execution_grants (expires_at);
