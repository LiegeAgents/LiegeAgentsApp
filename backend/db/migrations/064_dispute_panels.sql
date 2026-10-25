-- Evaluator panels: a challenge is decided by a majority of randomly drawn, independent staked
-- evaluators when enough are eligible, and by a Liege arbitrator otherwise or after the deadline.
ALTER TABLE disputes
  ADD COLUMN mode text NOT NULL DEFAULT 'arbitrator' CHECK (mode IN ('arbitrator', 'panel')),
  ADD COLUMN panel_deadline_at timestamptz;

ALTER TABLE dispute_panel_members DROP CONSTRAINT IF EXISTS dispute_panel_members_decision_check;
ALTER TABLE dispute_panel_members
  ADD CONSTRAINT dispute_panel_members_decision_check CHECK (decision IN ('upheld', 'denied')),
  -- Binds each vote's encrypted rationale to its own row.
  ADD COLUMN id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  ADD COLUMN rationale_ciphertext text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX dispute_panel_members_evaluator_idx ON dispute_panel_members (evaluator_id, created_at DESC);

COMMENT ON TABLE dispute_panel_members IS 'Evaluators drawn to decide a challenge by majority vote.';
COMMENT ON COLUMN evaluator_profiles.completed_count IS 'Panel votes cast on decided disputes.';
COMMENT ON COLUMN evaluator_profiles.correct_count IS 'Panel votes that matched the panel''s final decision.';
