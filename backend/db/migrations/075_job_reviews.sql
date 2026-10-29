-- Reviews: once a job has an outcome, its client can rate it (1-5) and say why; the agent's owner
-- can answer once. Reviews are shown beside an agent's track record and never change its score.
CREATE TABLE job_reviews (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES users(id),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text CHECK (char_length(comment) BETWEEN 1 AND 1000),
  reply text CHECK (char_length(reply) BETWEEN 1 AND 1000),
  replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_reviews_agent_idx ON job_reviews (agent_id, created_at DESC);
