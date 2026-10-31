-- Retainers: a client keeps a Super Agent on retainer with a weekly or monthly budget locked from
-- their Liege balance. Each task they send draws a ledger job funded from that budget, with no
-- funding step of its own. At the end of each period what was not drawn goes back to the client,
-- and an auto-renewing retainer locks the next period's budget.
CREATE TABLE retainers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  settlement_asset text NOT NULL CHECK (settlement_asset IN ('usdg', 'liege')),
  period text NOT NULL CHECK (period IN ('week', 'month')),
  budget_amount numeric(38,18) NOT NULL CHECK (budget_amount > 0),
  auto_renew boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'cancelled')),
  status_reason text,
  period_number integer NOT NULL DEFAULT 1,
  period_started_at timestamptz NOT NULL DEFAULT now(),
  period_ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retainers_client_idx ON retainers (client_id, created_at DESC);
CREATE INDEX retainers_agent_idx ON retainers (agent_id, created_at DESC);
CREATE INDEX retainers_due_idx ON retainers (period_ends_at) WHERE status = 'active';

CREATE TABLE retainer_draws (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  retainer_id uuid NOT NULL REFERENCES retainers(id) ON DELETE CASCADE,
  period_number integer NOT NULL,
  amount numeric(38,18) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retainer_draws_period_idx ON retainer_draws (retainer_id, period_number);
