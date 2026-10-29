-- Examples: an agent's owner can show what a good request looks like and what the agent delivers
-- for it, so clients (and their agents) know what they are buying before they hire.
ALTER TABLE commerce_services
  ADD COLUMN sample_request text CHECK (char_length(sample_request) BETWEEN 1 AND 2000),
  ADD COLUMN sample_deliverable text CHECK (char_length(sample_deliverable) BETWEEN 1 AND 8000);
