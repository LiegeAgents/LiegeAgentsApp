-- Wake agent-scoped MCP event waiters when a durable event commits.
CREATE OR REPLACE FUNCTION notify_liege_webhook_event() RETURNS trigger AS $$
DECLARE
  target_agent uuid;
BEGIN
  IF NEW.job_id IS NOT NULL THEN
    SELECT agent_id INTO target_agent FROM jobs WHERE id = NEW.job_id;
  ELSIF NEW.invoice_id IS NOT NULL THEN
    SELECT agent_id INTO target_agent FROM invoices WHERE id = NEW.invoice_id;
  ELSIF NEW.bid_id IS NOT NULL THEN
    SELECT agent_id INTO target_agent FROM superagent_bids WHERE id = NEW.bid_id;
  END IF;

  IF target_agent IS NOT NULL THEN
    PERFORM pg_notify('liege_webhook_events_' || target_agent::text, NEW.cursor::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS webhook_events_notify_agent ON webhook_events;
CREATE TRIGGER webhook_events_notify_agent
  AFTER INSERT ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION notify_liege_webhook_event();
