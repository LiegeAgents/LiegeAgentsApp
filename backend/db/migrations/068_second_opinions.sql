-- Second-opinion grading: an advisory grade of a delivery against its brief and acceptance
-- criteria, requested by the client or evaluator. It never settles a job.
CREATE TABLE job_second_opinions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  model text NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  -- The per-criterion findings quote the private delivery, so they are encrypted.
  result_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_second_opinions_job_idx ON job_second_opinions (job_id, created_at DESC);
