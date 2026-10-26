-- Rule-based approval: objective checks a client attaches to a job. Each delivery is checked
-- against them; on a Liege-ledger job the client decides, passing every check accepts it.
ALTER TABLE jobs ADD COLUMN approval_rules jsonb;
ALTER TABLE submissions ADD COLUMN rule_results jsonb;
