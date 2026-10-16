CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES job_events(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_id)
);

CREATE INDEX notifications_inbox_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;

CREATE FUNCTION notify_job_event_parties() RETURNS trigger LANGUAGE plpgsql AS $$
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
  ON CONFLICT (user_id, event_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER job_event_notifications
AFTER INSERT ON job_events
FOR EACH ROW EXECUTE FUNCTION notify_job_event_parties();
