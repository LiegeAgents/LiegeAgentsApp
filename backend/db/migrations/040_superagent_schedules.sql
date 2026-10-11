-- Recurring Super Agent jobs. One owner approval sets the agent, request, per-run budget,
-- cadence, and a total spending cap; each run opens a job exactly like an approved proposal.
CREATE TABLE superagent_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  request text NOT NULL CHECK (char_length(request) BETWEEN 1 AND 10000),
  settlement_asset text NOT NULL CHECK (settlement_asset IN ('usdg', 'liege')),
  budget_amount numeric(30,18) NOT NULL CHECK (budget_amount > 0),
  cadence text NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly')),
  -- Slots are anchored to starts_at (slot n = starts_at + n * cadence) so monthly runs do not
  -- drift after a short month.
  starts_at timestamptz NOT NULL,
  next_slot integer NOT NULL DEFAULT 0 CHECK (next_slot >= 0),
  next_run_at timestamptz NOT NULL,
  spend_cap numeric(30,18) NOT NULL CHECK (spend_cap >= budget_amount),
  committed_amount numeric(30,18) NOT NULL DEFAULT 0 CHECK (committed_amount >= 0),
  max_runs integer CHECK (max_runs BETWEEN 1 AND 1000),
  runs_count integer NOT NULL DEFAULT 0 CHECK (runs_count >= 0),
  auto_fund boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  status_reason text,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  source text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'cli')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (committed_amount <= spend_cap)
);
CREATE INDEX superagent_schedules_due_idx ON superagent_schedules (next_run_at) WHERE status = 'active';
CREATE INDEX superagent_schedules_user_idx ON superagent_schedules (user_id, created_at DESC);

CREATE TABLE superagent_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES superagent_schedules(id) ON DELETE CASCADE,
  slot timestamptz NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('funded', 'awaiting_funding', 'skipped', 'failed')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A slot runs at most once, however many API instances process the schedule.
  UNIQUE (schedule_id, slot)
);
CREATE INDEX superagent_schedule_runs_schedule_idx
  ON superagent_schedule_runs (schedule_id, created_at DESC);
