-- Notification preferences: a user mutes whole categories of in-app notifications. A muted
-- notification is never stored, so the inbox, its unread count, and the mobile feed all agree.
-- Disputes, slashing, and low-balance alerts have no category here and always arrive.
CREATE OR REPLACE FUNCTION notification_category(event_type text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN event_type IN ('job.opened', 'job.funded', 'job.submitted', 'job.revision_requested',
      'job.completed', 'job.rejected', 'job.expired', 'job.cancelled') THEN 'jobs'
    WHEN event_type IN ('job.reviewed', 'job.bonus_added') THEN 'feedback'
    WHEN event_type LIKE 'milestones.%' OR event_type LIKE 'retainer.%' THEN 'plans'
    WHEN event_type LIKE 'watch.%' OR event_type LIKE 'trigger.%' THEN 'automations'
  END
$$;

CREATE TABLE notification_mutes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('jobs', 'feedback', 'plans', 'automations')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

CREATE OR REPLACE FUNCTION drop_muted_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM notification_mutes
    WHERE user_id = NEW.user_id AND category = notification_category(NEW.event_type)
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER drop_muted_notification_trigger BEFORE INSERT ON notifications
FOR EACH ROW EXECUTE FUNCTION drop_muted_notification();
