CREATE TYPE ledger_account_kind AS ENUM ('available', 'escrow', 'stake', 'platform_clearing');

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind ledger_account_kind NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'escrow' AND job_id IS NOT NULL AND user_id IS NULL) OR (kind IN ('available', 'stake') AND user_id IS NOT NULL AND job_id IS NULL) OR (kind = 'platform_clearing' AND user_id IS NULL AND job_id IS NULL))
);
CREATE UNIQUE INDEX ledger_account_user_kind_idx ON ledger_accounts (user_id, kind) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_account_job_escrow_idx ON ledger_accounts (job_id) WHERE kind = 'escrow';
CREATE UNIQUE INDEX ledger_platform_clearing_idx ON ledger_accounts (kind) WHERE kind = 'platform_clearing';

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text UNIQUE NOT NULL,
  type text NOT NULL,
  created_by uuid REFERENCES users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_postings (
  id bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_usdg numeric(20,6) NOT NULL CHECK (amount_usdg <> 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_postings_account_idx ON ledger_postings (account_id, created_at DESC);
CREATE INDEX ledger_postings_transaction_idx ON ledger_postings (transaction_id);

CREATE OR REPLACE FUNCTION enforce_balanced_ledger_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tx_id uuid;
BEGIN
  tx_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  IF EXISTS (SELECT 1 FROM ledger_transactions WHERE id = tx_id) AND COALESCE((SELECT sum(amount_usdg) FROM ledger_postings WHERE transaction_id = tx_id), 0) <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is not balanced', tx_id;
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER balanced_ledger_transaction
AFTER INSERT OR UPDATE OR DELETE ON ledger_postings DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_balanced_ledger_transaction();
