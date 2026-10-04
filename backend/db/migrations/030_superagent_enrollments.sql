CREATE TABLE superagent_enrollments (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES commerce_services(id),
  webhook_id uuid NOT NULL REFERENCES webhook_subscriptions(id),
  enabled boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
