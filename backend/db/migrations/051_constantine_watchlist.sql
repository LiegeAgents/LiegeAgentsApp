-- Constantine watchlist: a daily schedule with a token attached. Each run is an ordinary rug-check
-- job; its structured result is kept so the next run can be compared with it, and the owner is
-- alerted only when a signal changes.
ALTER TABLE superagent_schedules
  ADD COLUMN watch_token text CHECK (watch_token ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN watch_chain text
    CHECK (watch_chain IN ('robinhood', 'ethereum', 'base', 'arbitrum', 'bsc')),
  ADD CONSTRAINT superagent_schedules_watch_pair CHECK ((watch_token IS NULL) = (watch_chain IS NULL));

-- One active watch per token and chain per user.
CREATE UNIQUE INDEX superagent_schedules_watch_idx ON superagent_schedules (user_id, watch_chain, watch_token)
  WHERE watch_token IS NOT NULL AND status IN ('active', 'paused');

CREATE TABLE superagent_watch_runs (
  -- One result per job; a revised delivery replaces it.
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES superagent_schedules(id) ON DELETE CASCADE,
  -- The result summary, encrypted (`watch-snapshot` context) and covered by `bun run reencrypt`.
  snapshot_ciphertext text NOT NULL,
  verdict text NOT NULL CHECK (char_length(verdict) BETWEEN 1 AND 40),
  risk_score integer CHECK (risk_score BETWEEN 0 AND 100),
  -- The first run of a watch is its baseline and never alerts.
  baseline boolean NOT NULL,
  -- Signals that worsened since the previous run: [{ signal, label, detail }].
  changes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(changes) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX superagent_watch_runs_schedule_idx ON superagent_watch_runs (schedule_id, created_at DESC);

-- A watch run's delivery is not news: the owner hears about it only through a `watch.alert`.
-- Same function as migration 049, plus the watch exception in the recipient filter.
CREATE OR REPLACE FUNCTION notify_job_event_parties() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row jobs%ROWTYPE;
  agent_name text;
  notification_title text;
  notification_message text;
BEGIN
  IF NEW.event_type NOT IN (
    'job.opened', 'job.funded', 'job.submitted', 'job.revision_requested',
    'job.completed', 'job.rejected', 'job.expired', 'job.cancelled'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT j.* INTO job_row
  FROM jobs j
  WHERE j.id = NEW.job_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT a.name INTO agent_name
  FROM agents a
  WHERE a.id = job_row.agent_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  notification_title := CASE NEW.event_type
    WHEN 'job.opened' THEN 'New job request'
    WHEN 'job.funded' THEN 'Job funded'
    WHEN 'job.submitted' THEN 'Delivery submitted'
    WHEN 'job.revision_requested' THEN 'Revision requested'
    WHEN 'job.completed' THEN 'Job completed'
    WHEN 'job.rejected' THEN 'Job closed'
    WHEN 'job.expired' THEN 'Job expired'
    WHEN 'job.cancelled' THEN 'Job cancelled'
  END;
  notification_message := CASE NEW.event_type
    WHEN 'job.opened' THEN 'A new request for "' || job_row.title || '" was created for ' || agent_name || '.'
    WHEN 'job.funded' THEN '"' || job_row.title || '" was funded in escrow.'
    WHEN 'job.submitted' THEN '"' || job_row.title || '" has a delivery ready for review.'
    WHEN 'job.revision_requested' THEN 'A revision was requested for "' || job_row.title || '".'
    WHEN 'job.completed' THEN '"' || job_row.title || '" was accepted. Check the job details for settlement status.'
    WHEN 'job.rejected' THEN '"' || job_row.title || '" was rejected. Check its details for the refund status.'
    WHEN 'job.expired' THEN '"' || job_row.title || '" reached its expiry deadline.'
    WHEN 'job.cancelled' THEN '"' || job_row.title || '" was cancelled.'
  END;

  INSERT INTO notifications (user_id, job_id, event_id, event_type, title, message, created_at)
  SELECT DISTINCT recipients.user_id, NEW.job_id, NEW.id, NEW.event_type,
    notification_title, notification_message, NEW.created_at
  FROM (
    SELECT job_row.client_id AS user_id
    UNION ALL SELECT a.owner_id FROM agents a WHERE a.id = job_row.agent_id
    UNION ALL SELECT job_row.evaluator_id
  ) AS recipients
  WHERE recipients.user_id IS NOT NULL
    AND (NEW.actor_id IS NULL OR recipients.user_id <> NEW.actor_id)
    AND NOT (
      NEW.event_type = 'job.submitted'
      AND recipients.user_id = job_row.client_id
      AND COALESCE(job_row.strategy_policy ->> 'watch', 'false') = 'true'
    )
  ON CONFLICT (user_id, event_id) DO NOTHING;

  RETURN NEW;
END;
$$;
