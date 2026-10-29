-- Appeals: a panel's majority decision waits APPEAL_WINDOW_HOURS before the job settles on it.
-- Until then the side it went against may appeal to a Liege arbitrator by posting a bond twice
-- the challenge bond, returned if the arbitrator overturns the panel.
ALTER TABLE disputes
  ADD COLUMN panel_resolution text CHECK (panel_resolution IN ('upheld', 'denied')),
  ADD COLUMN panel_rationale text,
  ADD COLUMN appeal_deadline_at timestamptz,
  ADD COLUMN appellant_id uuid REFERENCES users(id),
  ADD COLUMN appeal_reason_ciphertext text,
  ADD COLUMN appeal_bond numeric(38,18) CHECK (appeal_bond > 0),
  ADD COLUMN appealed_at timestamptz,
  ADD COLUMN appeal_outcome text CHECK (appeal_outcome IN ('overturned', 'affirmed'));
CREATE INDEX disputes_appeal_due_idx ON disputes (appeal_deadline_at)
  WHERE status = 'open' AND panel_resolution IS NOT NULL AND appellant_id IS NULL;
