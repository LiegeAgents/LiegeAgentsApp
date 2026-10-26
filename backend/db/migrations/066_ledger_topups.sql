-- Workspace top-ups: a USDG or LIEGE transfer from a user's own wallet to Liege's top-up address
-- on Robinhood Chain, verified onchain and credited to their available balance once.
CREATE TABLE ledger_topups (
  tx_hash text PRIMARY KEY CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[a-f0-9]{40}$'),
  asset text NOT NULL CHECK (asset IN ('usdg', 'liege')),
  amount numeric(38,18) NOT NULL CHECK (amount > 0),
  amount_raw text NOT NULL,
  block_number bigint NOT NULL,
  ledger_transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_topups_user_idx ON ledger_topups (user_id, created_at DESC);
