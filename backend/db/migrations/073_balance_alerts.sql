-- Low-balance alerts: a workspace sets a level per asset, and a debit that takes its available
-- balance from at or above that level to below it leaves a notification (and a Telegram message
-- when a chat is linked). Account notifications have no job, so job and event become optional.
CREATE TABLE balance_alerts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset text NOT NULL CHECK (asset IN ('usdg', 'liege')),
  threshold numeric(38,18) NOT NULL CHECK (threshold > 0),
  triggered_at timestamptz,
  pushed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset)
);

ALTER TABLE notifications
  ALTER COLUMN job_id DROP NOT NULL,
  ALTER COLUMN event_id DROP NOT NULL;
