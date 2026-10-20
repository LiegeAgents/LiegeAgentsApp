-- Onchain receipts: every settled job gets a receipt whose hash goes into a Merkle tree, and the
-- tree's root is written to Robinhood Chain in one transaction per batch. Only the root is
-- public; each party can fetch its receipt and proof and check them against the chain.
CREATE TABLE receipt_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merkle_root text NOT NULL CHECK (merkle_root ~ '^0x[0-9a-f]{64}$'),
  leaf_count integer NOT NULL CHECK (leaf_count > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'confirmed', 'failed')),
  chain_id integer NOT NULL,
  anchor_address text,
  tx_hash text CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  confirmed_at timestamptz
);
CREATE INDEX receipt_batches_open_idx ON receipt_batches (created_at) WHERE status IN ('pending', 'sent');

CREATE TABLE job_receipts (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  receipt jsonb NOT NULL,
  leaf_hash text NOT NULL CHECK (leaf_hash ~ '^0x[0-9a-f]{64}$'),
  batch_id uuid REFERENCES receipt_batches(id),
  leaf_index integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((batch_id IS NULL) = (leaf_index IS NULL))
);
CREATE INDEX job_receipts_unbatched_idx ON job_receipts (created_at) WHERE batch_id IS NULL;
CREATE INDEX job_receipts_batch_idx ON job_receipts (batch_id, leaf_index);
