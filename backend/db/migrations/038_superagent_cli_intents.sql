-- Super Agent proposals can also be drafted from the operator CLI chat mode.
ALTER TABLE superagent_intents DROP CONSTRAINT superagent_intents_source_check;
ALTER TABLE superagent_intents
  ADD CONSTRAINT superagent_intents_source_check CHECK (source IN ('x','dashboard','cli'));
