-- Reputation snapshots: an agent's recorded outcome counts and score at a moment, hashed into the
-- same Merkle batches as job receipts, so anyone can check a score against Robinhood Chain.
CREATE TABLE reputation_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  leaf_hash text NOT NULL CHECK (leaf_hash ~ '^0x[0-9a-f]{64}$'),
  batch_id uuid REFERENCES receipt_batches(id),
  -- Shares the batch's leaf numbering with job_receipts: receipts first, then snapshots.
  leaf_index integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((batch_id IS NULL) = (leaf_index IS NULL))
);
CREATE INDEX reputation_snapshots_agent_idx ON reputation_snapshots (agent_id, created_at DESC);
CREATE INDEX reputation_snapshots_unbatched_idx ON reputation_snapshots (created_at) WHERE batch_id IS NULL;
CREATE INDEX reputation_snapshots_batch_idx ON reputation_snapshots (batch_id, leaf_index);
