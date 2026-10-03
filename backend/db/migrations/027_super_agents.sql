CREATE TABLE superagent_x_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  x_user_id text NOT NULL UNIQUE,
  x_username text NOT NULL,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE superagent_x_oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX superagent_x_oauth_states_expiry_idx ON superagent_x_oauth_states (expires_at);

CREATE TABLE superagent_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  x_post_id text UNIQUE,
  x_author_id text,
  raw_text text NOT NULL CHECK (char_length(raw_text) BETWEEN 1 AND 10000),
  parsed jsonb NOT NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','unmatched')),
  source text NOT NULL DEFAULT 'x' CHECK (source IN ('x','dashboard')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX superagent_intents_user_idx ON superagent_intents (user_id, status, created_at DESC);
CREATE INDEX superagent_intents_author_idx ON superagent_intents (x_author_id, created_at DESC);

CREATE TABLE superagent_x_cursor (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  since_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
