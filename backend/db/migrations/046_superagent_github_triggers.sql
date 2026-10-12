-- GitHub triggers: one approval sets an agent, a public repository, a base branch, a per-run
-- budget, and a total spending cap. Every pull request opened or updated against that branch
-- opens (and optionally funds) a Super Agent job that reviews it. GitHub signs each delivery with
-- the trigger's own secret, which only someone who can add webhooks to the repository can use.
CREATE TABLE superagent_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  repository text NOT NULL CHECK (repository ~ '^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$' AND repository !~ '/\.\.?$'),
  branch text NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 255),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 2000),
  settlement_asset text NOT NULL CHECK (settlement_asset IN ('usdg', 'liege')),
  budget_amount numeric(30,18) NOT NULL CHECK (budget_amount > 0),
  spend_cap numeric(30,18) NOT NULL CHECK (spend_cap >= budget_amount),
  committed_amount numeric(30,18) NOT NULL DEFAULT 0 CHECK (committed_amount >= 0),
  runs_count integer NOT NULL DEFAULT 0 CHECK (runs_count >= 0),
  auto_fund boolean NOT NULL DEFAULT false,
  post_comment boolean NOT NULL DEFAULT true,
  secret_ciphertext text NOT NULL,
  verified_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  status_reason text,
  source text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'cli')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (committed_amount <= spend_cap)
);
CREATE INDEX superagent_triggers_user_idx ON superagent_triggers (user_id, created_at DESC);

CREATE TABLE superagent_trigger_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id uuid NOT NULL REFERENCES superagent_triggers(id) ON DELETE CASCADE,
  -- GitHub's delivery id: a redelivered event never opens a second job.
  delivery_id text NOT NULL,
  pull_number integer NOT NULL,
  head_sha text NOT NULL,
  title text NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('funded', 'awaiting_funding', 'skipped', 'failed')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trigger_id, delivery_id)
);
CREATE INDEX superagent_trigger_runs_trigger_idx
  ON superagent_trigger_runs (trigger_id, created_at DESC);
