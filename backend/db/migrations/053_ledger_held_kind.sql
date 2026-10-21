-- Funds held for an instant call while the agent answers. Added on its own: Postgres cannot use a
-- new enum value in the transaction that adds it.
ALTER TYPE ledger_account_kind ADD VALUE IF NOT EXISTS 'held';
