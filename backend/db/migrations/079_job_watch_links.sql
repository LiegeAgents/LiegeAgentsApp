-- Watch links: a client may share a read-only, public view of one job's progress (its title, the
-- agent, status, timestamps, and the agent's progress updates; never the brief, the deliverable,
-- or amounts). Revoking deletes the link; a new one gets a new token.
CREATE TABLE job_watch_links (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  token text UNIQUE NOT NULL CHECK (token ~ '^[A-Za-z0-9_-]{24}$'),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
