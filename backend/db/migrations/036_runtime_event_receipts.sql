CREATE TABLE IF NOT EXISTS runtime_event_receipts (
  event_id text NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (event_id, agent_id)
);

CREATE INDEX IF NOT EXISTS runtime_event_receipts_claimed_idx
  ON runtime_event_receipts (claimed_at);
