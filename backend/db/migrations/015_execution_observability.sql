CREATE TABLE execution_trace_events (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('tool_call', 'runtime', 'retry', 'artifact', 'checkpoint', 'cost', 'outcome')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX execution_trace_events_run_idx ON execution_trace_events (run_id, created_at, id);
