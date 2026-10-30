-- Milestone escrow: a client locks a whole project's budget for one Super Agent up front, from
-- their Liege balance, split into milestones. Each milestone is its own ledger job, funded from
-- the locked amount when the one before it is accepted and settled. A rejected or expired
-- milestone, or a cancelled plan, releases what was never started back to the client.
CREATE TABLE milestone_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  brief_ciphertext text NOT NULL,
  settlement_asset text NOT NULL CHECK (settlement_asset IN ('usdg', 'liege')),
  total_amount numeric(38,18) NOT NULL CHECK (total_amount > 0),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'stopped', 'cancelled')),
  status_reason text,
  released_amount numeric(38,18) NOT NULL DEFAULT 0 CHECK (released_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX milestone_plans_client_idx ON milestone_plans (client_id, created_at DESC);
CREATE INDEX milestone_plans_running_idx ON milestone_plans (updated_at) WHERE status = 'running';

CREATE TABLE milestone_plan_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES milestone_plans(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 7),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  acceptance_criteria jsonb NOT NULL,
  amount numeric(38,18) NOT NULL CHECK (amount > 0),
  job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  started_at timestamptz,
  UNIQUE (plan_id, position)
);
