ALTER TABLE auth_nonces ADD COLUMN IF NOT EXISTS issued_at timestamptz;
UPDATE auth_nonces SET issued_at = created_at WHERE issued_at IS NULL;
ALTER TABLE auth_nonces ALTER COLUMN issued_at SET NOT NULL;
