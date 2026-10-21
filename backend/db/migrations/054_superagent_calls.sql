-- A user's held account carries the price of their instant calls until each call ends.
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check CHECK (
  (kind = 'escrow' AND job_id IS NOT NULL AND user_id IS NULL)
  OR (kind IN ('available', 'stake', 'held') AND user_id IS NOT NULL AND job_id IS NULL)
  OR (kind = 'platform_clearing' AND user_id IS NULL AND job_id IS NULL)
);

-- Pay-per-call prices. NULL means the agent does not take instant calls in that asset.
ALTER TABLE superagent_enrollments
  ADD COLUMN call_price_usdg numeric(20,6) CHECK (call_price_usdg > 0),
  ADD COLUMN call_price_liege numeric(38,18) CHECK (call_price_liege > 0);

CREATE TABLE superagent_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  service_slug text NOT NULL,
  settlement_asset text NOT NULL CHECK (settlement_asset IN ('usdg', 'liege')),
  price numeric(38,18) NOT NULL CHECK (price > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'refunded')),
  idempotency_key text,
  input_ciphertext text NOT NULL,
  output_ciphertext text,
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX superagent_calls_idempotency_idx
  ON superagent_calls (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX superagent_calls_client_idx ON superagent_calls (client_id, created_at DESC);
CREATE INDEX superagent_calls_agent_idx ON superagent_calls (agent_id, created_at DESC);
CREATE INDEX superagent_calls_pending_idx ON superagent_calls (created_at) WHERE status = 'pending';
