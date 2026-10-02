-- Multi-asset invoices (USDG, LIEGE, USDC, USDe)
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'usdg',
  ADD COLUMN IF NOT EXISTS amount numeric(30,18);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_asset_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_asset_check CHECK (asset IN ('usdg', 'liege', 'usdc', 'usde'));

UPDATE invoices
SET amount = amount_usdg
WHERE amount IS NULL;

ALTER TABLE invoices
  ALTER COLUMN amount_usdg DROP NOT NULL;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_amount_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_amount_check CHECK (amount > 0);

ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'usdg',
  ADD COLUMN IF NOT EXISTS amount numeric(30,18);

ALTER TABLE invoice_payments DROP CONSTRAINT IF EXISTS invoice_payments_asset_check;
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_asset_check CHECK (asset IN ('usdg', 'liege', 'usdc', 'usde'));

UPDATE invoice_payments
SET amount = amount_usdg
WHERE amount IS NULL;

ALTER TABLE invoice_payments
  ALTER COLUMN amount_usdg DROP NOT NULL;

ALTER TABLE invoice_payments DROP CONSTRAINT IF EXISTS invoice_payments_amount_check;
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_amount_check CHECK (amount > 0);

ALTER TABLE invoice_refunds
  ADD COLUMN IF NOT EXISTS asset text NOT NULL DEFAULT 'usdg',
  ADD COLUMN IF NOT EXISTS amount numeric(30,18);

ALTER TABLE invoice_refunds DROP CONSTRAINT IF EXISTS invoice_refunds_asset_check;
ALTER TABLE invoice_refunds ADD CONSTRAINT invoice_refunds_asset_check CHECK (asset IN ('usdg', 'liege', 'usdc', 'usde'));

UPDATE invoice_refunds
SET amount = amount_usdg
WHERE amount IS NULL;

ALTER TABLE invoice_refunds
  ALTER COLUMN amount_usdg DROP NOT NULL;

ALTER TABLE invoice_refunds DROP CONSTRAINT IF EXISTS invoice_refunds_amount_check;
ALTER TABLE invoice_refunds ADD CONSTRAINT invoice_refunds_amount_check CHECK (amount > 0);

-- Allow new settlement assets in ledger accounts
ALTER TABLE ledger_accounts DROP CONSTRAINT IF EXISTS ledger_accounts_asset_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_asset_check CHECK (asset IN ('usdg', 'liege', 'usdc', 'usde'));

CREATE OR REPLACE FUNCTION sync_invoice_settlement_amounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset = 'usdg' THEN
    IF NEW.amount IS NULL THEN NEW.amount := NEW.amount_usdg; END IF;
    IF NEW.amount_usdg IS NULL THEN NEW.amount_usdg := NEW.amount; END IF;
  ELSE
    IF NEW.amount IS NULL AND NEW.amount_usdg IS NOT NULL THEN
      NEW.amount := NEW.amount_usdg;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS sync_invoice_settlement_amounts_trigger ON invoices;
CREATE TRIGGER sync_invoice_settlement_amounts_trigger BEFORE INSERT OR UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION sync_invoice_settlement_amounts();
