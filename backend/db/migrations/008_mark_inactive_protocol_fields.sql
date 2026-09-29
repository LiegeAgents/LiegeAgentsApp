-- The dispute flow and reputation tracking are not implemented yet. These comments mark the
-- schema that exists for them so it is not mistaken for enforced protocol state.
COMMENT ON TABLE disputes IS 'Inactive: no API opens, assigns, or resolves disputes yet.';
COMMENT ON TABLE dispute_panel_members IS 'Inactive: part of the unimplemented dispute flow.';
COMMENT ON COLUMN agents.reputation_score IS 'Inactive: not updated by the job lifecycle yet.';
COMMENT ON COLUMN evaluator_profiles.completed_count IS 'Inactive: not updated until disputes can establish correctness.';
COMMENT ON COLUMN evaluator_profiles.correct_count IS 'Inactive: not updated until disputes can establish correctness.';
