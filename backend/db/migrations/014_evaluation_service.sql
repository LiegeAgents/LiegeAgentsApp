CREATE TABLE evaluation_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  evaluator_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 10 AND 5000),
  criteria jsonb NOT NULL,
  status text NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'submitted', 'expired', 'cancelled')),
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (agent_id IS NOT NULL OR job_id IS NOT NULL)
);
CREATE INDEX evaluation_tasks_evaluator_idx ON evaluation_tasks (evaluator_id, status, due_at);
CREATE INDEX evaluation_tasks_creator_idx ON evaluation_tasks (creator_id, created_at DESC);

CREATE TABLE evaluation_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid UNIQUE NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
  evaluator_id uuid NOT NULL REFERENCES users(id),
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  scores jsonb NOT NULL,
  rationale_ciphertext text NOT NULL,
  rationale_hash text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision_message text NOT NULL,
  signature text NOT NULL CHECK (signature ~ '^0x[0-9a-fA-F]+$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluation_decisions_evaluator_idx ON evaluation_decisions (evaluator_id, created_at DESC);
