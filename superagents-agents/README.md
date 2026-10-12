# Liege Super Agents runtime

One Bun service hosts Scott, Anna, Marcus, Chloe, Daniel, and Kori. It consumes signed Liege
`job.funded` webhooks, fetches only the authorized job brief, routes the work to the assigned
handler, and submits the deliverable back through the Liege API.

The runtime has no wallet private key and never calls funding, signing, evaluation, or settlement
endpoints. Human approval and wallet operations remain in Liege. Duplicate events are ignored
in-process and durably claimed through Liege, and every job is checked for agent ownership, funded status, expiry, and delivery
deadline before Groq is called. Until a dedicated scoped worker token is enabled in the API, treat
`LIEGE_RUNTIME_TOKEN` as a scoped runtime credential:
rotate it if the runtime is compromised.

When a client sends a delivery back once with feedback (`job.revision_requested`), the agent
revises using the brief, the feedback, and its first deliverable, then resubmits. Anna's evidence
still comes only from client-supplied links, never from her generated first draft. Existing
webhook subscriptions must include `job.revision_requested`: rerun `bun run provision:webhooks`.

While it works, the runtime reports short milestones to `POST /v1/jobs/:id/progress` (picked up,
working on the deliverable, submitting). They mark real steps only, are shown to the client in
the dashboard, CLI chat, and Android app, and a failed report never delays or fails the job.

If a funded job cannot be completed, the runtime reports an agent decline to Liege with a reason.
Liege records `job.rejected` and refunds the client through the ledger or escrow settlement path;
the runtime never moves funds itself.

Clients can attach files and links to a job's brief before funding it. The runtime reads them
before drafting: text and Markdown as is, PDFs as extracted text, PNG/JPEG/WebP images through
the vision model (`GROQ_VISION_MODEL`, default `meta-llama/llama-4-scout-17b-16e-instruct`; if it
fails, the text model answers and says the images were not viewed), and public GitHub repository
links at one commit: the commit pinned on the link, else the link's branch, else the default
branch. Source files are read from that snapshot (READMEs first, vendored and lock files skipped)
and the snapshot URL is attached as evidence, so a review names exactly the code it covers. Other
links are passed on as client-supplied references but not opened. All of this stays within
`ATTACHMENT_CHAR_BUDGET` characters (default 24,000); set `GITHUB_TOKEN` (read-only, public repos)
to avoid GitHub's anonymous rate limit. An attachment that cannot be read becomes a note in the
prompt; it never fails the job.

Anna attaches up to 20 HTTPS source URLs found in the requester-provided brief, requirements, or attached links as
deliverable evidence. HTTP URLs and generated citations are not treated as verified sources.

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
