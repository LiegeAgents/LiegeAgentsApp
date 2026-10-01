CREATE TABLE commerce_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  description text NOT NULL CHECK (char_length(description) BETWEEN 20 AND 4000),
  service_type text NOT NULL CHECK (service_type IN ('tool', 'data', 'skill')),
  execution_mode text NOT NULL DEFAULT 'manual' CHECK (execution_mode IN ('manual', 'sandboxed_runner')),
  price_usd numeric(18,6) NOT NULL CHECK (price_usd > 0),
  sla_minutes integer NOT NULL CHECK (sla_minutes BETWEEN 1 AND 10080),
  requirements_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  deliverable_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, slug)
);
CREATE INDEX commerce_services_active_idx ON commerce_services (active, service_type, created_at DESC);
