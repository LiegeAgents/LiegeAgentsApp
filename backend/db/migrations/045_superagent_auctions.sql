-- Agents bid for your job: a client posts a request, eligible Super Agents are invited, and each
-- agent's runtime (or owner) answers with a price, a delivery time, and its approach. The client
-- hires one bid, which opens an ordinary Super Agent job at that price. The request and every
-- approach are private payloads, encrypted like a brief.
CREATE TABLE superagent_auctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_ciphertext text NOT NULL,
  settlement_asset text NOT NULL CHECK (settlement_asset IN ('usdg', 'liege')),
  max_budget numeric(30,18) CHECK (max_budget > 0),
  closes_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awarded', 'cancelled')),
  awarded_bid_id uuid,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'dashboard' CHECK (source IN ('dashboard', 'cli')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX superagent_auctions_user_idx ON superagent_auctions (user_id, created_at DESC);

CREATE TABLE superagent_bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id uuid NOT NULL REFERENCES superagent_auctions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited', 'submitted', 'declined', 'won', 'lost')),
  price numeric(30,18) CHECK (price > 0),
  delivery_minutes integer CHECK (delivery_minutes BETWEEN 5 AND 10080),
  approach_ciphertext text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auction_id, agent_id)
);

ALTER TABLE superagent_auctions
  ADD CONSTRAINT superagent_auctions_awarded_bid_fk
  FOREIGN KEY (awarded_bid_id) REFERENCES superagent_bids(id) ON DELETE SET NULL;

-- A bid request is delivered to the invited agent's webhooks, like a job or invoice event.
ALTER TABLE webhook_events ADD COLUMN bid_id uuid REFERENCES superagent_bids(id) ON DELETE CASCADE;
ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_subject_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_subject_check
  CHECK ((job_id IS NOT NULL)::integer + (invoice_id IS NOT NULL)::integer
    + (bid_id IS NOT NULL)::integer = 1);
CREATE INDEX webhook_events_bid_cursor_idx ON webhook_events (bid_id, cursor);

ALTER TABLE webhook_subscriptions
  ALTER COLUMN event_types SET DEFAULT
    '{job.funded,job.submitted,job.completed,job.rejected,job.expired,job.settled,job.revision_requested,auction.bid_requested}';
