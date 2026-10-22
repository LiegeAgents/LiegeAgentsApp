-- Onchain triggers: one approval sets an agent, a Robinhood Chain contract event to watch, a
-- per-run budget, and a total spending cap. When a matching event is seen, Liege opens (and
-- optionally funds) a Super Agent job about it. Limits keep a busy contract from piling up jobs:
-- a cooldown, a daily maximum, and at most one job waiting for funding at a time.
CREATE TABLE superagent_chain_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('token_transfer', 'contract_event')),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  event_signature text NOT NULL CHECK (char_length(event_signature) BETWEEN 3 AND 300),
  topic0 text NOT NULL CHECK (topic0 ~ '^0x[0-9a-f]{64}$'),
  -- Transfers only: the token's symbol and decimals, read when the trigger is created.
  token_symbol text CHECK (char_length(token_symbol) <= 40),
  token_decimals integer CHECK (token_decimals BETWEEN 0 AND 36),
  min_amount numeric(78,18) CHECK (min_amount > 0),
  watch_address text CHECK (watch_address ~ '^0x[0-9a-f]{40}$'),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 2000),
  settlement_asset text NOT NULL CHECK (settlement_asset IN ('usdg', 'liege')),
  budget_amount numeric(30,18) NOT NULL CHECK (budget_amount > 0),
  spend_cap numeric(30,18) NOT NULL CHECK (spend_cap >= budget_amount),
  committed_amount numeric(30,18) NOT NULL DEFAULT 0 CHECK (committed_amount >= 0),
  runs_count integer NOT NULL DEFAULT 0 CHECK (runs_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  cooldown_minutes integer NOT NULL DEFAULT 60 CHECK (cooldown_minutes BETWEEN 5 AND 10080),
  max_runs_per_day integer NOT NULL DEFAULT 4 CHECK (max_runs_per_day BETWEEN 1 AND 48),
  auto_fund boolean NOT NULL DEFAULT false,
  -- The last block scanned; scanning resumes after it, so each event is seen once.
  last_block bigint NOT NULL CHECK (last_block >= 0),
  last_polled_at timestamptz,
  last_fired_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'cancelled', 'completed')),
  status_reason text,
  source text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'cli')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (committed_amount <= spend_cap),
  CHECK (kind <> 'token_transfer' OR token_decimals IS NOT NULL),
  CHECK (kind = 'token_transfer' OR (min_amount IS NULL AND watch_address IS NULL))
);
CREATE INDEX superagent_chain_triggers_user_idx ON superagent_chain_triggers (user_id, created_at DESC);
CREATE INDEX superagent_chain_triggers_active_idx ON superagent_chain_triggers (last_polled_at NULLS FIRST)
  WHERE status = 'active';

CREATE TABLE superagent_chain_trigger_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id uuid NOT NULL REFERENCES superagent_chain_triggers(id) ON DELETE CASCADE,
  block_number bigint NOT NULL,
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL,
  summary text NOT NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('funded', 'awaiting_funding', 'skipped', 'failed')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trigger_id, tx_hash, log_index)
);
CREATE INDEX superagent_chain_trigger_runs_trigger_idx
  ON superagent_chain_trigger_runs (trigger_id, created_at DESC);
