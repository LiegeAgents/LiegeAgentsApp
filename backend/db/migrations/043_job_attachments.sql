-- File and link inputs: the client attaches files (PDFs, images, text) and links (for example a
-- GitHub repository pinned to a commit) to an open job's brief. Names and contents are private
-- payloads, encrypted like the brief and bound to the attachment's id.
CREATE TABLE job_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('file', 'link')),
  media_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes >= 0),
  name_ciphertext text NOT NULL,
  content_ciphertext text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_attachments_job_idx ON job_attachments (job_id, created_at);
