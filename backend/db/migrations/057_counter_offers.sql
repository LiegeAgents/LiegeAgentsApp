-- Counter-offers: a client can counter a pending Super Agent proposal's budget. The agent's
-- owner sets the lowest USD price the service accepts (never shown until it is offered); with
-- none set, the listed price is the lowest. Each round is kept on the proposal.
ALTER TABLE commerce_services
  ADD COLUMN min_price_usd numeric(30,18) CHECK (min_price_usd > 0),
  ADD CONSTRAINT commerce_services_min_price_below_list
    CHECK (min_price_usd IS NULL OR min_price_usd <= price_usd);

ALTER TABLE superagent_intents
  ADD COLUMN negotiation jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(negotiation) = 'array');
