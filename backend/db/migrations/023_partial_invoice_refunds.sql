-- Partial invoice refunds bound to jobId & reason
-- Enables partial refunds against paid or partially refunded invoices.
-- Tracks cumulative refunded amount, optional jobId reference, and human/agent readable reason.

-- 1. Add partially_refunded status to invoice_status enum
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'partially_refunded';

-- 2. Add cumulative refunded_amount tracking to invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(30,18) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_amount_usdg numeric(20,6) NOT NULL DEFAULT 0;

-- Backfill refunded_amount for already refunded invoices
UPDATE invoices
SET refunded_amount = amount,
    refunded_amount_usdg = COALESCE(amount_usdg, amount)
WHERE status = 'refunded' AND (refunded_amount IS NULL OR refunded_amount = 0);

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_refunded_amount_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_refunded_amount_check CHECK (refunded_amount >= 0 AND refunded_amount <= amount);

-- 3. Drop single-refund restriction on invoice_refunds so multiple partial refunds can be issued
ALTER TABLE invoice_refunds DROP CONSTRAINT IF EXISTS invoice_refunds_invoice_id_key;

-- 4. Add jobId and reason to invoice_refunds
ALTER TABLE invoice_refunds
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason text;

ALTER TABLE invoice_refunds DROP CONSTRAINT IF EXISTS invoice_refunds_reason_check;
ALTER TABLE invoice_refunds ADD CONSTRAINT invoice_refunds_reason_check CHECK (reason IS NULL OR char_length(reason) <= 500);

-- 5. Indexes for fast lookups
CREATE INDEX IF NOT EXISTS invoice_refunds_invoice_id_idx ON invoice_refunds (invoice_id, refunded_at DESC);
CREATE INDEX IF NOT EXISTS invoice_refunds_job_id_idx ON invoice_refunds (job_id) WHERE job_id IS NOT NULL;
