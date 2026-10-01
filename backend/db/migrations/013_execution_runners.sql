CREATE TABLE execution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  command text NOT NULL,
  args jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out')),
  exit_code integer,
  timeout_ms integer NOT NULL,
  max_output_bytes integer NOT NULL,
  stdout text NOT NULL DEFAULT '',
  stderr text NOT NULL DEFAULT '',
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_runs_owner_idx ON execution_runs (owner_id, created_at DESC);
CREATE INDEX execution_runs_agent_idx ON execution_runs (agent_id, created_at DESC);

CREATE TABLE execution_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL,
  content_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, name)
);
CREATE INDEX execution_artifacts_run_idx ON execution_artifacts (run_id, created_at);
