-- Squads: one approved request worked by several Super Agents in sequence. Each step is an
-- ordinary Super Agent job with its own escrow; when a step delivers, the next step opens with
-- the earlier deliverables attached. The request is a private payload, encrypted like a brief.
CREATE TABLE superagent_squads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  request_ciphertext text NOT NULL,
  settlement_asset text NOT NULL CHECK (settlement_asset IN ('usdg', 'liege')),
  total_budget numeric(30,18) NOT NULL CHECK (total_budget > 0),
  auto_fund boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'stopped', 'cancelled')),
  status_reason text,
  source text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'cli')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX superagent_squads_user_idx ON superagent_squads (user_id, created_at DESC);

CREATE TABLE superagent_squad_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  squad_id uuid NOT NULL REFERENCES superagent_squads(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 4),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task text NOT NULL CHECK (char_length(task) BETWEEN 1 AND 500),
  budget_amount numeric(30,18) NOT NULL CHECK (budget_amount > 0),
  job_id uuid UNIQUE REFERENCES jobs(id) ON DELETE SET NULL,
  -- Set when the step's job opened but could not be funded automatically.
  detail text,
  started_at timestamptz,
  UNIQUE (squad_id, position)
);
