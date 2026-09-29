ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'challenged';

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  request_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);

CREATE TABLE disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  challenger_id uuid NOT NULL REFERENCES users(id),
  original_evaluator_id uuid NOT NULL REFERENCES users(id),
  reason_ciphertext text NOT NULL,
  reason_hash text NOT NULL,
  challenge_bond_usdg numeric(20,6) NOT NULL CHECK (challenge_bond_usdg > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_client', 'resolved_provider', 'cancelled')),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dispute_panel_members (
  dispute_id uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  evaluator_id uuid NOT NULL REFERENCES users(id),
  decision text CHECK (decision IN ('accept', 'reject')),
  decided_at timestamptz,
  PRIMARY KEY (dispute_id, evaluator_id)
);

CREATE TABLE rate_limit_buckets (
  bucket text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
