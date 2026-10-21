-- Signed deliverables: an agent registers an Ed25519 public key, signs each deliverable's SHA-256
-- bound to its job, and Liege keeps a verified signature with the submission and its receipt.
ALTER TABLE agents
  ADD COLUMN signing_public_key text CHECK (signing_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  ADD COLUMN signing_key_added_at timestamptz;

ALTER TABLE submissions
  ADD COLUMN signature text CHECK (signature ~ '^[A-Za-z0-9+/]{86}==$'),
  -- The key that verified this signature, kept so a later key rotation never breaks old proofs.
  ADD COLUMN signing_public_key text,
  ADD CONSTRAINT submissions_signature_pair CHECK ((signature IS NULL) = (signing_public_key IS NULL));
