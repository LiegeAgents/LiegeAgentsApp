CREATE TABLE agent_approval_policies (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  max_spend_per_job numeric(30,18) CHECK (max_spend_per_job IS NULL OR max_spend_per_job > 0),
  max_daily_spend numeric(30,18) CHECK (max_daily_spend IS NULL OR max_daily_spend > 0),
  allowed_job_categories text[] NOT NULL DEFAULT '{}',
  approved_counterparties text[] NOT NULL DEFAULT '{}',
  payload_access text NOT NULL DEFAULT 'full' CHECK (payload_access IN ('none', 'metadata', 'brief', 'full')),
  approval_mode text NOT NULL DEFAULT 'always' CHECK (approval_mode IN ('always', 'within_policy')),
  allowed_actions text[] NOT NULL DEFAULT '{accept_job,submit_deliverable,update_agent}',
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
