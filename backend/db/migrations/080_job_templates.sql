-- Job templates: a client saves a job they open often (title, brief, acceptance criteria, approval
-- rules, and optionally an agent, asset, and budget) under a name, and fills the job form from it.
-- The brief is encrypted like a job's brief. Saving under an existing name replaces that template.
CREATE TABLE job_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  brief_ciphertext text NOT NULL,
  acceptance_criteria jsonb NOT NULL,
  approval_rules jsonb,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  settlement_asset text NOT NULL DEFAULT 'usdg' CHECK (settlement_asset IN ('usdg', 'liege')),
  budget numeric(38,18) CHECK (budget > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
