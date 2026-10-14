ALTER TYPE escrow_mode ADD VALUE IF NOT EXISTS 'veilora';

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS veilora_escrow_address text
    CHECK (veilora_escrow_address IS NULL OR veilora_escrow_address ~ '^0x[a-f0-9]{40}$'),
  ADD COLUMN IF NOT EXISTS veilora_escrow_terms jsonb,
  ADD COLUMN IF NOT EXISTS veilora_terms_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS veilora_settlement_tx_hash text
    CHECK (veilora_settlement_tx_hash IS NULL OR veilora_settlement_tx_hash ~ '^0x[0-9a-f]{64}$');

CREATE TABLE IF NOT EXISTS veilora_funding_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  escrow_address text NOT NULL CHECK (escrow_address ~ '^0x[a-f0-9]{40}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS veilora_funding_quotes_job_idx
  ON veilora_funding_quotes (job_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS veilora_fundings (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  factory_tx_hash text UNIQUE CHECK (factory_tx_hash IS NULL OR factory_tx_hash ~ '^0x[0-9a-f]{64}$'),
  token_tx_hash text NOT NULL UNIQUE CHECK (token_tx_hash ~ '^0x[0-9a-f]{64}$'),
  funded_amount_raw numeric(78,0) NOT NULL CHECK (funded_amount_raw > 0),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_veilora_escrow_address_unique
  ON jobs (veilora_escrow_address)
  WHERE veilora_escrow_address IS NOT NULL;

COMMENT ON COLUMN jobs.veilora_escrow_terms IS
  'Immutable Veilora escrow terms snapshot; legacy escrow_wallets remain for existing jobs.';

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS veilora_deliverable_commit text
    CHECK (veilora_deliverable_commit IS NULL OR veilora_deliverable_commit ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS veilora_deliverable_salt text
    CHECK (veilora_deliverable_salt IS NULL OR veilora_deliverable_salt ~ '^0x[0-9a-f]{64}$');
