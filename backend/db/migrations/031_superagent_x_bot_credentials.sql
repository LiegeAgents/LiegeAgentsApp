CREATE TABLE superagent_x_bot_credentials (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  access_token_ciphertext text NOT NULL,
  refresh_token_ciphertext text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
