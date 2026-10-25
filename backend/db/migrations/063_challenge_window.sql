-- Challenge window: on Liege-ledger jobs an evaluator's decision is paid out only after the window
-- closes, and the side the decision went against may challenge it first.
-- NULL means the platform default (CHALLENGE_WINDOW_HOURS) applies when the job is decided.
ALTER TABLE jobs
  ADD COLUMN challenge_window_hours integer CHECK (challenge_window_hours BETWEEN 0 AND 168),
  ADD COLUMN payout_due_at timestamptz,
  ADD COLUMN payout_released_at timestamptz;
CREATE INDEX jobs_payout_due_idx ON jobs (payout_due_at)
  WHERE payout_due_at IS NOT NULL AND payout_released_at IS NULL;

ALTER TABLE disputes
  ADD COLUMN asset text NOT NULL DEFAULT 'usdg' CHECK (asset IN ('usdg', 'liege')),
  ADD COLUMN decided_outcome text CHECK (decided_outcome IN ('accepted', 'rejected')),
  ADD COLUMN resolver_id uuid REFERENCES users(id),
  ADD COLUMN resolution text CHECK (resolution IN ('upheld', 'denied')),
  ADD COLUMN resolution_rationale_ciphertext text;
-- The bond is held in the challenge's asset; the column name predates multi-asset jobs.
COMMENT ON COLUMN disputes.challenge_bond_usdg IS 'Challenge bond in the dispute''s asset.';
COMMENT ON TABLE disputes IS 'Challenges of an evaluator decision during a ledger job''s challenge window, resolved by a Liege arbitrator.';
COMMENT ON TABLE dispute_panel_members IS 'Inactive: evaluator panels are not implemented yet; a Liege arbitrator resolves disputes.';
