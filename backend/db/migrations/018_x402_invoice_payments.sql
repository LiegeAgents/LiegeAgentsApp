-- x402 payments are settled by a facilitator, so they do not have an internal ledger transaction.
ALTER TABLE invoice_payments
  ALTER COLUMN payer_id DROP NOT NULL,
  ALTER COLUMN ledger_transaction_id DROP NOT NULL;
ALTER TABLE invoice_payments
  ADD COLUMN payment_method text NOT NULL DEFAULT 'liege_ledger'
    CHECK (payment_method IN ('liege_ledger', 'x402')),
  ADD COLUMN payer_wallet text,
  ADD COLUMN settlement_transaction text,
  ADD COLUMN settlement_network text;
ALTER TABLE invoice_payments
  ADD CONSTRAINT invoice_payment_method_fields_check CHECK (
    (payment_method = 'liege_ledger' AND ledger_transaction_id IS NOT NULL AND payer_id IS NOT NULL)
    OR (payment_method = 'x402' AND settlement_transaction IS NOT NULL AND settlement_network IS NOT NULL AND payer_wallet IS NOT NULL)
  );
