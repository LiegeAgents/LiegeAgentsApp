ALTER TABLE superagent_x_oauth_states ALTER COLUMN user_id DROP NOT NULL;

CREATE TABLE superagent_x_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_hash text NOT NULL UNIQUE,
  x_user_id text NOT NULL,
  x_username text NOT NULL,
  access_token_ciphertext text NOT NULL,
  refresh_token_ciphertext text,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX superagent_x_claims_expiry_idx ON superagent_x_claims (expires_at);
