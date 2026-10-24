-- Reputation checks need only know which jobs have ever been returned for revision.
-- A partial job_id index avoids scanning unrelated lifecycle events for dashboard reads.
CREATE INDEX IF NOT EXISTS job_events_revision_job_idx
  ON job_events (job_id)
  WHERE event_type = 'job.revision_requested';
