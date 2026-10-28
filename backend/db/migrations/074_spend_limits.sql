-- Spend limits: the most a workspace's available balance may spend, per asset, in any 24 hours and
-- in any 30 days, net of refunds. Lowering a limit applies at once; raising or removing one waits
-- a day (next_* until next_at), so a stolen session cannot simply lift it and drain the balance.
CREATE TABLE spend_limits (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset text NOT NULL CHECK (asset IN ('usdg', 'liege')),
  daily_limit numeric(38,18) CHECK (daily_limit >= 0),
  monthly_limit numeric(38,18) CHECK (monthly_limit >= 0),
  next_daily_limit numeric(38,18) CHECK (next_daily_limit >= 0),
  next_monthly_limit numeric(38,18) CHECK (next_monthly_limit >= 0),
  next_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset)
);
