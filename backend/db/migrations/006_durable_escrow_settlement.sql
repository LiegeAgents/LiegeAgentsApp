-- Durable on-chain settlement. The outcome and one row per payout are committed before anything
-- is signed; each payout's nonce and signed transaction are stored before it is broadcast.
-- The tx hash columns on escrow_settlements are kept only for rows settled before this migration.
ALTER TABLE escrow_settlements
  ADD COLUMN cause text NOT NULL DEFAULT 'evaluation' CHECK (cause IN ('evaluation', 'expiry')),
  ADD COLUMN lease_until timestamptz;
CREATE INDEX escrow_settlements_unfinished_idx ON escrow_settlements (updated_at) WHERE status IN ('pending', 'failed');

CREATE TABLE escrow_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES escrow_settlements(job_id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position >= 0),
  purpose text NOT NULL CHECK (purpose IN ('provider_payment', 'evaluator_fee', 'client_refund', 'usdg_sweep', 'eth_sweep')),
  asset text NOT NULL CHECK (asset IN ('usdg', 'eth')),
  recipient text NOT NULL CHECK (recipient ~ '^0x[a-f0-9]{40}$'),
  -- Fixed for payments and refunds; for sweeps, the amount signed most recently.
  amount_raw numeric(78,0) CHECK (amount_raw > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'confirmed', 'skipped', 'reverted')),
  nonce integer CHECK (nonce >= 0),
  signed_tx text,
  tx_hashes text[] NOT NULL DEFAULT '{}',
  confirmed_tx_hash text CHECK (confirmed_tx_hash ~ '^0x[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, position),
  CHECK (purpose IN ('usdg_sweep', 'eth_sweep') OR amount_raw IS NOT NULL),
  CHECK (status NOT IN ('signed', 'confirmed', 'reverted') OR (nonce IS NOT NULL AND signed_tx IS NOT NULL))
);
