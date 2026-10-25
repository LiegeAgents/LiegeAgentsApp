-- Evaluator slashing: when a challenge overturns an independent evaluator's decision, part of
-- their stake goes to the challenger they wronged.
ALTER TABLE disputes
  ADD COLUMN slashed_evaluator_id uuid REFERENCES users(id),
  ADD COLUMN slashed_amount numeric(38,18) CHECK (slashed_amount > 0);
CREATE INDEX disputes_slashed_evaluator_idx ON disputes (slashed_evaluator_id)
  WHERE slashed_evaluator_id IS NOT NULL;
