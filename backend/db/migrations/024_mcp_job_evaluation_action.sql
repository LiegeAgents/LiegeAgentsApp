ALTER TABLE mcp_proposals DROP CONSTRAINT IF EXISTS mcp_proposals_action_check;
ALTER TABLE mcp_proposals
  ADD CONSTRAINT mcp_proposals_action_check
  CHECK (action IN ('accept_job', 'submit_deliverable', 'evaluate_job', 'update_agent'));

ALTER TABLE agent_approval_policies
  ALTER COLUMN allowed_actions SET DEFAULT '{accept_job,submit_deliverable,evaluate_job,update_agent}';

UPDATE agent_approval_policies
SET allowed_actions = array_append(allowed_actions, 'evaluate_job')
WHERE NOT ('evaluate_job' = ANY(allowed_actions));
