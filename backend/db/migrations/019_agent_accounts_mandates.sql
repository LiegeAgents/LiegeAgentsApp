-- Agent accounts are deterministic control-plane identities: the account id is the
-- existing agent id, so adding an account never creates a second wallet or custody path.
CREATE TABLE agent_accounts (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'killed')),
  kill_reason text,
  paused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_account_policies (
  agent_id uuid PRIMARY KEY REFERENCES agent_accounts(agent_id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  max_action_amount numeric(30,18) CHECK (max_action_amount IS NULL OR max_action_amount > 0),
  daily_budget numeric(30,18) CHECK (daily_budget IS NULL OR daily_budget > 0),
  monthly_budget numeric(30,18) CHECK (monthly_budget IS NULL OR monthly_budget > 0),
  allowed_assets text[] NOT NULL DEFAULT '{}',
  allowed_venues text[] NOT NULL DEFAULT '{}',
  approved_counterparties text[] NOT NULL DEFAULT '{}',
  allowed_actions text[] NOT NULL DEFAULT '{}',
  approval_mode text NOT NULL DEFAULT 'always' CHECK (approval_mode IN ('always', 'within_policy')),
  simulation_required boolean NOT NULL DEFAULT true,
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_account_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agent_accounts(agent_id) ON DELETE CASCADE,
  action text NOT NULL,
  amount numeric(30,18),
  asset text,
  venue text,
  counterparty text,
  decision text NOT NULL CHECK (decision IN ('simulation', 'approval_required', 'approved', 'denied')),
  reasons text[] NOT NULL DEFAULT '{}',
  policy_version integer NOT NULL,
  simulation_digest text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_account_actions_budget_idx ON agent_account_actions (agent_id, created_at DESC)
  WHERE decision IN ('approved', 'approval_required');

CREATE TABLE agent_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agent_accounts(agent_id) ON DELETE CASCADE,
  issuer_id uuid NOT NULL REFERENCES users(id),
  parent_mandate_id uuid REFERENCES agent_mandates(id),
  nonce text NOT NULL,
  digest text NOT NULL,
  payload jsonb NOT NULL,
  signature text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, nonce)
);
CREATE INDEX agent_mandates_account_idx ON agent_mandates (agent_id, status, expires_at);
