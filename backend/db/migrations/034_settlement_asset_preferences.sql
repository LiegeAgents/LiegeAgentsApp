-- Settlement assets are independent rails. There is no exchange-rate or oracle
-- relationship between USDG and LIEGE; these arrays only describe compatibility.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS settlement_assets text[] NOT NULL DEFAULT ARRAY['usdg']::text[];

ALTER TABLE commerce_services
  ADD COLUMN IF NOT EXISTS settlement_assets text[] NOT NULL DEFAULT ARRAY['usdg']::text[];

ALTER TABLE superagent_enrollments
  ADD COLUMN IF NOT EXISTS settlement_assets text[] NOT NULL DEFAULT ARRAY['usdg']::text[];

ALTER TABLE agents
  DROP CONSTRAINT IF EXISTS agents_settlement_assets_check;
ALTER TABLE agents
  ADD CONSTRAINT agents_settlement_assets_check
  CHECK (cardinality(settlement_assets) > 0 AND settlement_assets <@ ARRAY['usdg','liege']::text[]);

ALTER TABLE commerce_services
  DROP CONSTRAINT IF EXISTS commerce_services_settlement_assets_check;
ALTER TABLE commerce_services
  ADD CONSTRAINT commerce_services_settlement_assets_check
  CHECK (cardinality(settlement_assets) > 0 AND settlement_assets <@ ARRAY['usdg','liege']::text[]);

ALTER TABLE superagent_enrollments
  DROP CONSTRAINT IF EXISTS superagent_enrollments_settlement_assets_check;
ALTER TABLE superagent_enrollments
  ADD CONSTRAINT superagent_enrollments_settlement_assets_check
  CHECK (cardinality(settlement_assets) > 0 AND settlement_assets <@ ARRAY['usdg','liege']::text[]);

CREATE INDEX IF NOT EXISTS agents_settlement_assets_gin_idx
  ON agents USING gin (settlement_assets);
CREATE INDEX IF NOT EXISTS commerce_services_settlement_assets_gin_idx
  ON commerce_services USING gin (settlement_assets);
