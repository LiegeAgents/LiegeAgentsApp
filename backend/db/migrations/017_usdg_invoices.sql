-- Liege Pay v1: fixed USDG invoices settled through the existing internal USDG ledger.
-- x402 is intentionally not enabled here; it is an adapter once the USDG/chain facilitator
-- compatibility check has a verified production path.
CREATE TYPE invoice_status AS ENUM ('issued', 'paid', 'refunded', 'cancelled', 'expired');

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text UNIQUE NOT NULL DEFAULT ('INV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  issuer_id uuid NOT NULL REFERENCES users(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 500),
  reference text CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 120),
  amount_usdg numeric(20,6) NOT NULL CHECK (amount_usdg > 0),
  status invoice_status NOT NULL DEFAULT 'issued',
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  refunded_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX invoices_issuer_idx ON invoices (issuer_id, created_at DESC);
CREATE INDEX invoices_agent_idx ON invoices (agent_id, status, created_at DESC);
CREATE INDEX invoices_open_expiry_idx ON invoices (expires_at) WHERE status = 'issued';

-- An owner may cap the size of invoices issued for a particular agent. Existing policies remain
-- unbounded until explicitly configured.
ALTER TABLE agent_approval_policies
  ADD COLUMN max_invoice_amount numeric(20,6) CHECK (max_invoice_amount IS NULL OR max_invoice_amount > 0);

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid UNIQUE NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payer_id uuid NOT NULL REFERENCES users(id),
  ledger_transaction_id uuid UNIQUE NOT NULL REFERENCES ledger_transactions(id),
  amount_usdg numeric(20,6) NOT NULL CHECK (amount_usdg > 0),
  paid_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoice_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid UNIQUE NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  payer_id uuid NOT NULL REFERENCES users(id),
  issuer_id uuid NOT NULL REFERENCES users(id),
  ledger_transaction_id uuid UNIQUE NOT NULL REFERENCES ledger_transactions(id),
  amount_usdg numeric(20,6) NOT NULL CHECK (amount_usdg > 0),
  refunded_at timestamptz NOT NULL DEFAULT now()
);

-- Invoice lifecycle uses the same signed delivery and durable cursor infrastructure as jobs.
ALTER TABLE webhook_events ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE webhook_events ADD COLUMN invoice_id uuid REFERENCES invoices(id) ON DELETE CASCADE;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_subject_check
  CHECK ((job_id IS NOT NULL)::integer + (invoice_id IS NOT NULL)::integer = 1);
CREATE INDEX webhook_events_invoice_cursor_idx ON webhook_events (invoice_id, cursor);
