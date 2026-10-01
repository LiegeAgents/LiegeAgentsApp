-- A timestamp is not a replay cursor: multiple events can share one timestamp and clocks do not
-- provide an ordering guarantee. Give every persisted lifecycle event a durable, monotonic cursor.
CREATE SEQUENCE webhook_events_cursor_seq AS bigint;

ALTER TABLE webhook_events ADD COLUMN cursor bigint;

WITH ordered AS (
  SELECT id, nextval('webhook_events_cursor_seq') AS cursor
  FROM webhook_events
  ORDER BY created_at ASC, id ASC
)
UPDATE webhook_events AS event
SET cursor = ordered.cursor
FROM ordered
WHERE event.id = ordered.id;

ALTER TABLE webhook_events
  ALTER COLUMN cursor SET DEFAULT nextval('webhook_events_cursor_seq'),
  ALTER COLUMN cursor SET NOT NULL;

ALTER SEQUENCE webhook_events_cursor_seq OWNED BY webhook_events.cursor;
CREATE UNIQUE INDEX webhook_events_cursor_idx ON webhook_events (cursor);
CREATE INDEX webhook_events_job_cursor_idx ON webhook_events (job_id, cursor);
