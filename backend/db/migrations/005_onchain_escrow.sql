CREATE TYPE escrow_mode AS ENUM ('ledger', 'onchain');

ALTER TABLE jobs ADD COLUMN escrow_mode escrow_mode NOT NULL DEFAULT 'ledger';

CREATE TABLE escrow_wallets (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  address text UNIQUE NOT NULL CHECK (address ~ '^0x[a-f0-9]{40}$'),
  encrypted_private_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE escrow_funding_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  gas_reserve_wei numeric(78,0) NOT NULL CHECK (gas_reserve_wei > 0),
  eth_usd_price numeric(20,8) NOT NULL CHECK (eth_usd_price > 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX escrow_funding_quotes_job_idx ON escrow_funding_quotes (job_id, expires_at DESC);

CREATE TABLE escrow_fundings (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  usdg_tx_hash text UNIQUE NOT NULL CHECK (usdg_tx_hash ~ '^0x[0-9a-f]{64}$'),
  gas_tx_hash text UNIQUE NOT NULL CHECK (gas_tx_hash ~ '^0x[0-9a-f]{64}$'),
  usdg_amount_raw numeric(78,0) NOT NULL CHECK (usdg_amount_raw > 0),
  gas_amount_wei numeric(78,0) NOT NULL CHECK (gas_amount_wei > 0),
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE escrow_settlements (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  outcome evaluation_outcome NOT NULL,
  provider_tx_hash text CHECK (provider_tx_hash ~ '^0x[0-9a-f]{64}$'),
  evaluator_tx_hash text CHECK (evaluator_tx_hash ~ '^0x[0-9a-f]{64}$'),
  refund_tx_hash text CHECK (refund_tx_hash ~ '^0x[0-9a-f]{64}$'),
  gas_refund_tx_hash text CHECK (gas_refund_tx_hash ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'complete', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
