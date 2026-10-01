CREATE TABLE agent_account_simulations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agent_accounts(agent_id) ON DELETE CASCADE,
  policy_version integer NOT NULL,
  action_digest text NOT NULL UNIQUE,
  action jsonb NOT NULL,
  result jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_account_simulations_account_idx ON agent_account_simulations (agent_id, created_at DESC);

ALTER TABLE agent_account_actions
  ADD COLUMN simulation_id uuid UNIQUE REFERENCES agent_account_simulations(id),
  ADD COLUMN normalized_action jsonb,
  ADD COLUMN receipt_digest text,
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN execution_status text NOT NULL DEFAULT 'not_started'
    CHECK (execution_status IN ('not_started', 'running', 'succeeded', 'failed')),
  ADD COLUMN executed_at timestamptz;

ALTER TABLE execution_runs
  ADD COLUMN agent_account_action_id uuid REFERENCES agent_account_actions(id);

ALTER TABLE mcp_proposals
  ADD COLUMN simulation_id uuid REFERENCES agent_account_simulations(id);
