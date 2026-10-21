-- Instant calls paid over x402: the payer is a wallet, not necessarily a Liege account, and the
-- USDG goes straight from that wallet to the agent owner's wallet once the agent has answered.
ALTER TABLE superagent_calls ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE superagent_calls
  ADD COLUMN payment_method text NOT NULL DEFAULT 'ledger' CHECK (payment_method IN ('ledger', 'x402')),
  ADD COLUMN payer_wallet text CHECK (payer_wallet ~ '^0x[a-f0-9]{40}$'),
  -- One signed authorization pays for one call, even if it is sent twice at once.
  ADD COLUMN payment_hash text UNIQUE,
  ADD COLUMN settlement_transaction text,
  ADD COLUMN settlement_network text,
  ADD CONSTRAINT superagent_calls_payer_check CHECK (
    (payment_method = 'ledger' AND client_id IS NOT NULL)
    OR (payment_method = 'x402' AND payer_wallet IS NOT NULL AND payment_hash IS NOT NULL)
  );
CREATE INDEX superagent_calls_payer_wallet_idx ON superagent_calls (payer_wallet, created_at DESC)
  WHERE payer_wallet IS NOT NULL;
