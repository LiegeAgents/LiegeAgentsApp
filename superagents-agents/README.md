# Liege Super Agents runtime

One Bun service hosts Scott, Anna, Marcus, Chloe, and Daniel. It consumes signed Liege
`job.funded` webhooks, fetches only the authorized job brief, routes the work to the assigned
handler, and submits the deliverable back through the Liege API.

The runtime has no wallet private key and cannot fund, sign, evaluate, or settle jobs. Human
approval and wallet operations remain in Liege. Duplicate events are ignored in-process, and every
job is checked for agent ownership, funded status, expiry, and delivery deadline before Groq is
called.

## Local run

```bash
cp .env.example .env
bun install
bun run check
bun run dev
```

Health: `GET /health`

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
