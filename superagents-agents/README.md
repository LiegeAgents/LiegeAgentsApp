# Liege Super Agents runtime

One Bun service hosts Scott, Anna, Marcus, Chloe, Daniel, and Kori. It consumes signed Liege
`job.funded` webhooks, fetches only the authorized job brief, routes the work to the assigned
handler, and submits the deliverable back through the Liege API.

The runtime has no wallet private key and never calls funding, signing, evaluation, or settlement
endpoints. Human approval and wallet operations remain in Liege. Duplicate events are ignored
in-process, and every job is checked for agent ownership, funded status, expiry, and delivery
deadline before Groq is called. Until a dedicated scoped worker token is enabled in the API, treat
`LIEGE_RUNTIME_TOKEN` as a scoped runtime credential:
rotate it if the runtime is compromised.

If a funded job cannot be completed, the runtime reports an agent decline to Liege with a reason.
Liege records `job.rejected` and refunds the client through the ledger or escrow settlement path;
the runtime never moves funds itself.

## Local run

```bash
cp .env.example .env
bun install
bun run check
bun run dev
```

Health: `GET /health`

## Provision webhooks

After placing a valid owner session token and `AGENT_SERVER_URL` in `.env`, provision the
flagship subscriptions (plus Kori's when `KORI_AGENT_ID` is set) and write their canonical UUIDs and one-time signing secrets back
to `.env`:

```bash
bun run provision:webhooks
```

The command replaces matching subscriptions for the runtime URLs. Copy the resulting
`*_WEBHOOK_SECRET` values into the deployed service environment, then redeploy it.

Webhook URLs:

```text
POST /webhooks/scott
POST /webhooks/anna
POST /webhooks/marcus
POST /webhooks/chloe
POST /webhooks/daniel
POST /webhooks/kori
```

Create one HTTPS webhook subscription per Liege agent for `job.funded`, `job.expired`, and
`job.settled`. Store the one-time secrets returned by Liege as the matching `*_WEBHOOK_SECRET`.
The runtime ignores the latter two events; they are subscribed to keep delivery state observable.

## Kori by LiegeAgents

Kori is the customer service agent. Its one service, `customer-support`, takes a customer's
message plus any business context in the brief (product details, policies, order information)
and returns the reply to send to that customer. Its voice is calm, warm, and
direct, with at most one mild friendly joke and never when the customer is upset. It answers only
from facts in the brief, says plainly when information is missing, and never claims refunds,
escalations, lookups, or account changes it did not perform. Keys, seed phrases, and API tokens pasted into
a brief are replaced with `[REDACTED_SECRET]` before the model sees them, and the reply advises
the customer to treat them as exposed.

Kori is optional at runtime: it is served, and listed by `/health`, only when both
`KORI_AGENT_ID` and `KORI_WEBHOOK_SECRET` are set. Setting only one fails startup. Follow the
Kori handoff for creating the agent, service, webhook, and enrollment, and keep discovery
disabled until a funded-job test completes.

`strategyPolicy.serviceSlug` may select a service-specific handler. When it is absent, the runtime
uses the agent's default handler. The first production verification should be an Anna job before
enabling all five agents.
