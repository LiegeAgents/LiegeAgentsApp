-- A Liege-ion is a temporary team assembled by the lead provider of a parent job.
-- Funds never leave the parent job's escrow until the parent job is accepted.
CREATE TABLE legions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid UNIQUE NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  lead_agent_id uuid NOT NULL REFERENCES agents(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legion_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legion_id uuid NOT NULL REFERENCES legions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  brief_ciphertext text NOT NULL,
  brief_hash text NOT NULL,
  allocation_bps integer NOT NULL CHECK (allocation_bps BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'submitted', 'declined')),
  deliverable_ciphertext text,
  deliverable_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  submitted_at timestamptz,
  declined_at timestamptz,
  UNIQUE (legion_id, agent_id)
);
CREATE INDEX legion_assignments_agent_idx ON legion_assignments (agent_id, status, created_at DESC);

ALTER TABLE escrow_payouts DROP CONSTRAINT IF EXISTS escrow_payouts_purpose_check;
ALTER TABLE escrow_payouts ADD CONSTRAINT escrow_payouts_purpose_check CHECK (purpose IN ('provider_payment', 'legion_payment', 'evaluator_fee', 'client_refund', 'token_sweep', 'usdg_sweep', 'eth_sweep'));
