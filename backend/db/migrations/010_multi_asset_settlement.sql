-- Dual-asset settlement. Existing rows remain USDG; new jobs may opt into LIEGE.
ALTER TABLE jobs
  ADD COLUMN settlement_asset text NOT NULL DEFAULT 'usdg' CHECK (settlement_asset IN ('usdg', 'liege')),
  ADD COLUMN budget_amount numeric(30,18),
  ADD COLUMN evaluator_fee_amount numeric(30,18);

UPDATE jobs
SET budget_amount = budget_usdg,
    evaluator_fee_amount = evaluator_fee_usdg
WHERE budget_amount IS NULL;

ALTER TABLE jobs
  ALTER COLUMN budget_usdg DROP NOT NULL,
  ALTER COLUMN evaluator_fee_usdg DROP NOT NULL,
  ADD CONSTRAINT jobs_budget_amount_check CHECK (budget_amount > 0),
  ADD CONSTRAINT jobs_evaluator_fee_amount_check CHECK (evaluator_fee_amount >= 0);

CREATE OR REPLACE FUNCTION sync_job_settlement_amounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.settlement_asset = 'usdg' THEN
    IF NEW.budget_amount IS NULL THEN NEW.budget_amount := NEW.budget_usdg; END IF;
    IF NEW.evaluator_fee_amount IS NULL THEN NEW.evaluator_fee_amount := COALESCE(NEW.evaluator_fee_usdg, 0); END IF;
    IF NEW.budget_usdg IS NULL THEN NEW.budget_usdg := NEW.budget_amount; END IF;
    IF NEW.evaluator_fee_usdg IS NULL THEN NEW.evaluator_fee_usdg := NEW.evaluator_fee_amount; END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS sync_job_settlement_amounts_trigger ON jobs;
CREATE TRIGGER sync_job_settlement_amounts_trigger BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION sync_job_settlement_amounts();

ALTER TABLE ledger_accounts
  ADD COLUMN asset text NOT NULL DEFAULT 'usdg' CHECK (asset IN ('usdg', 'liege'));
DROP INDEX IF EXISTS ledger_account_user_kind_idx;
DROP INDEX IF EXISTS ledger_account_job_escrow_idx;
DROP INDEX IF EXISTS ledger_platform_clearing_idx;
CREATE UNIQUE INDEX ledger_account_user_kind_asset_idx ON ledger_accounts (user_id, kind, asset) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_account_job_escrow_asset_idx ON ledger_accounts (job_id, asset) WHERE kind = 'escrow';
CREATE UNIQUE INDEX ledger_platform_clearing_asset_idx ON ledger_accounts (kind, asset) WHERE kind = 'platform_clearing';

ALTER TABLE ledger_postings
  ADD COLUMN amount numeric(30,18),
  ALTER COLUMN amount_usdg DROP NOT NULL;
UPDATE ledger_postings SET amount = amount_usdg WHERE amount IS NULL;
ALTER TABLE ledger_postings
  ADD CONSTRAINT ledger_postings_amount_check CHECK (amount IS NOT NULL AND amount <> 0);

ALTER TABLE escrow_fundings
  ADD COLUMN token_tx_hash text,
  ADD COLUMN token_amount_raw numeric(78,0),
  ADD COLUMN settlement_asset text NOT NULL DEFAULT 'usdg' CHECK (settlement_asset IN ('usdg', 'liege'));
UPDATE escrow_fundings SET token_tx_hash = usdg_tx_hash, token_amount_raw = usdg_amount_raw;

ALTER TABLE escrow_payouts DROP CONSTRAINT IF EXISTS escrow_payouts_asset_check;
ALTER TABLE escrow_payouts ADD CONSTRAINT escrow_payouts_asset_check CHECK (asset IN ('usdg', 'liege', 'eth'));
ALTER TABLE escrow_payouts DROP CONSTRAINT IF EXISTS escrow_payouts_purpose_check;
ALTER TABLE escrow_payouts ADD CONSTRAINT escrow_payouts_purpose_check CHECK (purpose IN ('provider_payment', 'evaluator_fee', 'client_refund', 'token_sweep', 'usdg_sweep', 'eth_sweep'));
ALTER TABLE escrow_payouts DROP CONSTRAINT IF EXISTS escrow_payouts_check;
ALTER TABLE escrow_payouts ADD CONSTRAINT escrow_payouts_amount_required_check CHECK (purpose IN ('usdg_sweep', 'token_sweep', 'eth_sweep') OR amount_raw IS NOT NULL);

CREATE OR REPLACE FUNCTION enforce_balanced_ledger_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tx_id uuid;
BEGIN
  tx_id := COALESCE(NEW.transaction_id, OLD.transaction_id);
  IF EXISTS (SELECT 1 FROM ledger_transactions WHERE id = tx_id)
     AND COALESCE((SELECT sum(amount) FROM ledger_postings WHERE transaction_id = tx_id), 0) <> 0 THEN
    RAISE EXCEPTION 'Ledger transaction % is not balanced', tx_id;
  END IF;
  RETURN NULL;
END; $$;
