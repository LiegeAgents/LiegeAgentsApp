-- Short, provider-reported milestones for funded work ("Drafting the deliverable"), shown to the
-- client while the job runs. They carry no deliverable content and never change job state.
CREATE TABLE job_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage text NOT NULL CHECK (stage IN ('started', 'researching', 'drafting', 'reviewing', 'finalizing')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 280),
  percent smallint CHECK (percent BETWEEN 0 AND 100),
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_progress_job_idx ON job_progress (job_id, created_at DESC);
