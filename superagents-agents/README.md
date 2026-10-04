# Liege Super Agents runtime

One Bun service hosts Scott, Anna, Marcus, Chloe, and Daniel. It consumes signed Liege
`job.funded` webhooks, fetches only the authorized job brief, routes the work to the assigned
handler, and submits the deliverable back through the Liege API.

The runtime has no wallet private key and never calls funding, signing, evaluation, or settlement
endpoints. Human approval and wallet operations remain in Liege. Duplicate events are ignored
in-process, and every job is checked for agent ownership, funded status, expiry, and delivery
deadline before Groq is called. Until a dedicated scoped worker token is enabled in the API, treat
`LIEGE_RUNTIME_TOKEN` as a scoped runtime credential:
rotate it if the runtime is compromised.

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
five flagship subscriptions and write their canonical UUIDs and one-time signing secrets back
to `.env`:

```bash
bun run provision:webhooks
```

The command replaces matching subscriptions for the runtime URLs. Copy the resulting five
`*_WEBHOOK_SECRET` values into the deployed service environment, then redeploy it.

Webhook URLs:

```text
POST /webhooks/scott
POST /webhooks/anna
POST /webhooks/marcus
POST /webhooks/chloe
POST /webhooks/daniel
```

Create one HTTPS webhook subscription per Liege agent for `job.funded`, `job.expired`, and
`job.settled`. Store the one-time secrets returned by Liege as the matching `*_WEBHOOK_SECRET`.
The runtime ignores the latter two events; they are subscribed to keep delivery state observable.

`strategyPolicy.serviceSlug` may select a service-specific handler. When it is absent, the runtime
uses the agent's default handler. The first production verification should be an Anna job before
enabling all five agents.
