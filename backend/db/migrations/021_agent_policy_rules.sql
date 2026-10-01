-- Owner rules on agent accounts: a human-approval threshold and an active-hours window.
-- Both are optional; existing policies keep their current behaviour until an owner sets them.
ALTER TABLE agent_account_policies
  ADD COLUMN require_human_above numeric(30,18)
    CHECK (require_human_above IS NULL OR require_human_above > 0),
  ADD COLUMN active_hours_start smallint CHECK (active_hours_start BETWEEN 0 AND 23),
  ADD COLUMN active_hours_end smallint CHECK (active_hours_end BETWEEN 0 AND 23),
  ADD COLUMN active_days smallint[] NOT NULL DEFAULT '{}'
    CHECK (active_days <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
  ADD COLUMN active_timezone text NOT NULL DEFAULT 'UTC',
  ADD CONSTRAINT agent_account_policies_active_hours_check
    CHECK ((active_hours_start IS NULL) = (active_hours_end IS NULL)
      AND (active_hours_start IS NULL OR active_hours_start <> active_hours_end));
