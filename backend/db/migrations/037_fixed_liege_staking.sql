-- Fixed-term LIEGE staking positions and auditable pool payouts.
CREATE TABLE liege_staking_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address varchar(42) NOT NULL,
  term_days integer NOT NULL CHECK (term_days IN (30, 45, 90)),
  apy_bps integer NOT NULL CHECK (apy_bps > 0),
  principal_amount numeric(78, 0) NOT NULL CHECK (principal_amount > 0),
  reward_amount numeric(78, 0) NOT NULL CHECK (reward_amount >= 0),
  starts_at timestamptz NOT NULL,
  unlocks_at timestamptz NOT NULL CHECK (unlocks_at > starts_at),
  deposit_tx_hash varchar(66) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'claimed')),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX liege_staking_locks_wallet_idx ON liege_staking_locks (lower(wallet_address), created_at DESC);
CREATE INDEX liege_staking_locks_maturity_idx ON liege_staking_locks (unlocks_at) WHERE status = 'locked';

CREATE TABLE liege_staking_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lock_id uuid NOT NULL UNIQUE REFERENCES liege_staking_locks(id),
  wallet_address varchar(42) NOT NULL,
  amount numeric(78, 0) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'signed', 'broadcast', 'confirmed', 'failed')),
  serialized_tx text,
  tx_nonce bigint,
  tx_hash varchar(66) UNIQUE,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
