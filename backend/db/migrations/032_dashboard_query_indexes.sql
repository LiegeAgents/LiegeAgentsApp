-- Keep the owner-scoped dashboard and job list queries index-backed while
-- preserving the existing status-oriented indexes used by lifecycle workers.
CREATE INDEX jobs_client_created_idx ON jobs (client_id, created_at DESC);
CREATE INDEX jobs_agent_created_idx ON jobs (agent_id, created_at DESC);
CREATE INDEX agents_owner_created_idx ON agents (owner_id, created_at DESC);

-- Super Agent discovery filters by enabled/verified enrollments and then joins
-- the live service and webhook rows.
CREATE INDEX superagent_enrollments_discovery_idx
  ON superagent_enrollments (enabled, verified_at, agent_id)
  WHERE enabled = true AND verified_at IS NOT NULL;
