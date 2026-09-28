CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE job_status AS ENUM ('open', 'funded', 'submitted', 'completed', 'rejected', 'expired', 'cancelled');
CREATE TYPE job_kind AS ENUM ('standard', 'trade_stock_token', 'manage_vault', 'subscription', 'fund_transfer');
CREATE TYPE evaluation_outcome AS ENUM ('accepted', 'rejected');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text UNIQUE NOT NULL CHECK (wallet_address ~ '^0x[a-f0-9]{40}$'),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_nonces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[a-f0-9]{40}$'),
  nonce text UNIQUE NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_nonces_wallet_open_idx ON auth_nonces (wallet_address, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  slug text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  description text NOT NULL CHECK (char_length(description) BETWEEN 20 AND 2000),
  category text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  reputation_score numeric(5,2) NOT NULL DEFAULT 0 CHECK (reputation_score BETWEEN 0 AND 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_active_category_idx ON agents (category, created_at DESC) WHERE active;

CREATE TABLE evaluator_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stake_usdg numeric(20,6) NOT NULL DEFAULT 0 CHECK (stake_usdg >= 0),
  specialties jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT false,
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  correct_count integer NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id text UNIQUE NOT NULL DEFAULT ('JOB-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  client_id uuid NOT NULL REFERENCES users(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  evaluator_id uuid REFERENCES users(id),
  kind job_kind NOT NULL DEFAULT 'standard',
  status job_status NOT NULL DEFAULT 'open',
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  brief_ciphertext text,
  brief_hash text NOT NULL,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_usdg numeric(20,6) NOT NULL CHECK (budget_usdg > 0),
  evaluator_fee_usdg numeric(20,6) NOT NULL DEFAULT 0 CHECK (evaluator_fee_usdg >= 0),
  deadline_at timestamptz NOT NULL,
  funded_at timestamptz,
  submitted_at timestamptz,
  settled_at timestamptz,
  expires_at timestamptz NOT NULL,
  strategy_policy jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at >= deadline_at)
);
CREATE INDEX jobs_agent_status_idx ON jobs (agent_id, status, created_at DESC);
CREATE INDEX jobs_client_status_idx ON jobs (client_id, status, created_at DESC);
CREATE INDEX jobs_expiry_idx ON jobs (expires_at) WHERE status IN ('open', 'funded', 'submitted');

CREATE TABLE job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_events_job_idx ON job_events (job_id, created_at);

CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES users(id),
  deliverable_ciphertext text,
  deliverable_hash text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  evaluator_id uuid NOT NULL REFERENCES users(id),
  outcome evaluation_outcome NOT NULL,
  rationale_ciphertext text,
  rationale_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cron_runs (
  name text NOT NULL,
  idempotency_key text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (name, idempotency_key)
);
