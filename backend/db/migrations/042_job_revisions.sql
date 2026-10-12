-- One revision round: whoever settles a submitted job (its evaluator, or else the client) can
-- send it back once with feedback instead of rejecting it. Escrow stays where it is; the first
-- deliverable is kept here, and the job returns to funded with a later delivery deadline.
ALTER TABLE jobs ADD COLUMN revision_count integer NOT NULL DEFAULT 0
  CHECK (revision_count BETWEEN 0 AND 1);

CREATE TABLE job_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  feedback_ciphertext text NOT NULL,
  feedback_hash text NOT NULL,
  previous_deliverable_ciphertext text,
  previous_deliverable_hash text NOT NULL,
  previous_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_submitted_at timestamptz NOT NULL,
  previous_deadline_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE webhook_subscriptions
  ALTER COLUMN event_types SET DEFAULT
    '{job.funded,job.submitted,job.completed,job.rejected,job.expired,job.settled,job.revision_requested}';
