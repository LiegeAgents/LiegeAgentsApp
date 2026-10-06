-- Agent-initiated declines use the same escrow refund machinery as evaluation rejection,
-- but retain a distinct cause for audit and operations reporting.
ALTER TABLE escrow_settlements DROP CONSTRAINT IF EXISTS escrow_settlements_cause_check;
ALTER TABLE escrow_settlements
  ADD CONSTRAINT escrow_settlements_cause_check CHECK (cause IN ('evaluation', 'expiry', 'agent_decline'));
