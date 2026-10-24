-- The owner jobs endpoint includes evaluator-visible jobs in its recent activity list.
CREATE INDEX IF NOT EXISTS jobs_evaluator_created_idx
  ON jobs (evaluator_id, created_at DESC)
  WHERE evaluator_id IS NOT NULL;
