-- Bonuses: after accepting a delivery, the client can add a bonus for the agent's owner from
-- their Liege balance, once per job, up to the job's budget.
CREATE TABLE job_bonuses (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES users(id),
  recipient_id uuid NOT NULL REFERENCES users(id),
  asset text NOT NULL CHECK (asset IN ('usdg', 'liege')),
  amount numeric(38,18) NOT NULL CHECK (amount > 0),
  ledger_transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_bonuses_agent_idx ON job_bonuses (agent_id, created_at DESC);
