-- Liege on Telegram: a workspace links one Telegram account through a one-time code, then runs
-- rug checks (instant calls from its balance, under a daily cap) and prepares proposals.
CREATE TABLE telegram_links (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_user_id bigint UNIQUE NOT NULL,
  chat_id bigint NOT NULL,
  username text,
  daily_cap_usdg numeric(20,6) NOT NULL DEFAULT 5 CHECK (daily_cap_usdg >= 0 AND daily_cap_usdg <= 100),
  linked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telegram_link_codes (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telegram_link_codes_user_idx ON telegram_link_codes (user_id, created_at DESC);

-- Telegram redelivers an update it thinks failed; each is handled once.
CREATE TABLE telegram_updates (
  update_id bigint PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE superagent_calls
  ADD COLUMN source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'telegram'));
CREATE INDEX superagent_calls_telegram_spend_idx ON superagent_calls (client_id, created_at)
  WHERE source = 'telegram';

ALTER TABLE superagent_intents
  DROP CONSTRAINT superagent_intents_source_check,
  ADD CONSTRAINT superagent_intents_source_check
    CHECK (source IN ('x', 'dashboard', 'cli', 'mcp', 'telegram'));
