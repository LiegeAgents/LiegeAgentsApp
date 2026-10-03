CREATE TABLE mobile_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_pairing_codes_user_idx ON mobile_pairing_codes (user_id, created_at DESC);

CREATE TABLE mobile_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  platform text NOT NULL DEFAULT 'android' CHECK (platform = 'android'),
  app_version text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_devices_user_idx ON mobile_devices (user_id, created_at DESC);

CREATE TABLE mobile_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES mobile_devices(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_hash text UNIQUE NOT NULL,
  refresh_token_hash text UNIQUE NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['mobile:read', 'mobile:approve'],
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_sessions_device_idx ON mobile_sessions (device_id, revoked_at);
CREATE INDEX mobile_sessions_user_idx ON mobile_sessions (user_id, created_at DESC);
