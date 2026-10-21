# Liege API

Off-chain API for Liege marketplace state. Users sign in by signing a login message; the service never holds a user's wallet key or signs on a user's behalf.

In production escrow deployments, `ESCROW_MODE=veilora` enables per-job routing: jobs with an independent evaluator use Veilora V2; jobs without one use Liege's existing on-chain escrow, where the client reviews the delivery. The selected route is stored on the job and is not changed by quote failures or reads. Keep both Veilora factory addresses configured so existing V1 jobs remain compatible. `ESCROW_MODE=onchain` also enables this routing; `ESCROW_MODE=ledger` deliberately keeps all jobs on the internal balance ledger for local/test deployments.

The Liege on-chain escrow path is custodial: it generates a wallet for each job, stores that wallet's private key encrypted with `DATA_ENCRYPTION_KEY`, and signs the wallet's payout and refund transfers. Anyone with the database and that key controls every active escrow wallet.

## Run

```sh
cp .env.example .env
bun install
bun run migrate
bun run dev
```

`DATABASE_URL`, `RHC_RPC_URL`, `AUTH_TOKEN_PEPPER`, `DATA_ENCRYPTION_KEY`, `CRON_SECRET`, `ADMIN_WALLET_ADDRESSES`, `MCP_INTERNAL_API_TOKEN`, `RUNNER_WORKER_URL`, and `RUNNER_WORKER_TOKEN` are required for a production deployment, and `DATA_ENCRYPTION_KEY` must differ from `AUTH_TOKEN_PEPPER`. `CRON_SECRET` protects maintenance endpoints. Production never executes runner workloads inside the API process.

The opt-in x402 invoice adapter additionally uses `X402_FACILITATOR_URL`, `USDG_TOKEN_ADDRESS`, `USDG_TOKEN_NAME`, `USDG_TOKEN_VERSION`, and `X402_MAX_TIMEOUT_SECONDS`. It serves x402 v2 exact EVM requirements from `GET /v1/invoices/:id/x402`, verifies `PAYMENT-SIGNATURE`, settles through the facilitator, and records the on-chain receipt. It is disabled unless both a facilitator URL and USDG token address are configured. x402 refunds are intentionally rejected until a refund-capable facilitator flow is configured.

Briefs, deliverables, rationales, and escrow wallet keys are encrypted at rest with keys derived from `DATA_ENCRYPTION_KEY`, each bound to its record and purpose. The server holds the key and can read them, so this is not end-to-end encryption. To rotate the key, move the old one to `DATA_ENCRYPTION_KEY_PREVIOUS`, set the new one, deploy, run `bun run reencrypt`, then remove the previous key. The same command upgrades rows written in the older format, which stay readable until then.

Each client IP gets 120 requests a minute, with separate budgets of 20 for sign-in and 20 for the on-chain funding routes. Client IPs come from `X-Forwarded-For` as allowed by `TRUST_PROXY` (default `1`, one proxy hop); set it to the address or CIDR range of the proxy in front of the service, and accept traffic only from that proxy, or clients can pick their own rate limit bucket.

## Deploy

CI builds the image with the commit it was built from, which `GET /health` reports as `commit`. On `main`, the deploy job runs in the `production` GitHub environment (add required reviewers there to gate deploys), triggers the Render deploy hook, and, when the `BACKEND_URL` repository variable is set, fails unless that commit is serving and ready within ten minutes. Releases are tagged only after a successful deploy. On startup, each process takes a lock and applies pending migrations; it refuses to start if an applied migration was edited or removed.

## Test

```sh
bun run test
```

The integration tests drop and rebuild the schema of a disposable Postgres database whose name must end in `_test` (default `postgresql://liege:liege@localhost:5432/liege_test`; override with `DATABASE_URL`). Without one, the database tests are skipped locally; CI always runs them. `bun run format:check` enforces Prettier formatting.

## API surface

[`docs/openapi.yaml`](../docs/openapi.yaml) is the contract for every route, including request and response schemas; `tests/contract.test.ts` fails when a route or response drifts from it. Every error has the shape `{ "error": { "code", "message", "requestId", "fields"? } }`, where `requestId` matches the `X-Request-Id` header.

| Area            | Endpoints                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health          | `GET /health`                                                                                                                                                                                                             |
| Wallet sessions | `POST /v1/auth/nonce`, `POST /v1/auth/verify`, `POST /v1/auth/logout`                                                                                                                                                     |
| Agents          | `GET /v1/agents`, `GET /v1/agents/:slug`, `POST /v1/agents`                                                                                                                                                               |
| Evaluators      | `GET /v1/evaluators`, `GET /v1/evaluators/me`, `PUT /v1/evaluators/me`                                                                                                                                                    |
| Liege admin     | `POST /v1/admin/ledger/credit`, `POST /v1/admin/evaluators/stake`, `POST /v1/admin/escrows/backfill`, `GET /v1/admin/settlements`, `POST /v1/admin/settlements/:jobId/retry`, `POST /v1/admin/settlements/:jobId/resweep` |
| Jobs            | `GET /v1/jobs`, `POST /v1/jobs`, `POST /v1/jobs/:id/fund`, `POST /v1/jobs/:id/submit`, `POST /v1/jobs/:id/decline`, `POST /v1/jobs/:id/evaluate`                                                                          |
| Webhooks & SSE  | `POST/GET /v1/webhooks`, `DELETE /v1/webhooks/:id`, `GET /v1/webhooks/stream/:agentId`, `POST /v1/cron/deliver-webhooks`                                                                                                  |
| Runners         | `POST /v1/runners`, `GET /v1/runners`, `GET /v1/runners/:id`                                                                                                                                                              |
| Evaluation      | `POST/GET /v1/evaluations/tasks`, `GET /v1/evaluations/tasks/:id`, `POST /v1/evaluations/tasks/:id/decision-message`, `POST /v1/evaluations/tasks/:id/submit`                                                             |
| MCP             | User-scoped `/v1/mcp/*` connections and proposals; service-only `/v1/internal/mcp/*` context and proposal routes                                                                                                          |
| Maintenance     | `POST /v1/cron/expire-jobs`, `POST /v1/cron/settle-escrows`, `POST /v1/cron/deliver-webhooks`, `POST /v1/cron/run-schedules`                                                                                              |
| LIEGE staking   | Public fixed-term pool config, verified deposits, wallet positions, and matured claims under `/v1/staking/*`                                                                                                              |

Protected user routes require `Authorization: Bearer <session-token>`. Cron calls require `X-Cron-Secret`; `expire-jobs` also takes a JSON `idempotencyKey`, making repeat delivery safe.

### Pay-per-call

Small requests can be answered while the client waits, with no escrow, evaluator, or job. An agent's owner sets a price per call in each enrolled asset with `PUT /v1/super-agents/enrollments/:agentId/call-prices` (at most `INSTANT_CALL_MAX_USDG`, default 5, or `INSTANT_CALL_MAX_LIEGE`, default 25,000; `null` turns calls off). `POST /v1/super-agents/calls` moves the price from the client's available ledger balance to their `held` account (`402 insufficient_credits` when it cannot), then posts a signed `superagent.call` event to the agent's enrolled webhook URL with the same SSRF pinning as the connection test, and waits up to `INSTANT_CALL_TIMEOUT_MS` (default 45 seconds). The owner is paid only when the runtime answers `{"data":{"status":"answered","output":"…"}}` with `X-Liege-Call-Proof: HMAC-SHA256(webhook secret, "superagent.call:<callId>:<sha256(output)>")`. A decline (`"status":"declined"`), timeout, error, oversized answer, or missing proof refunds the client in full and returns `502 call_failed` with the call. An `idempotencyKey` makes retries return the first call without charging again, and a sweeper refunds any call left pending by a restart. Inputs and answers are encrypted (`call-input`, `call-output`) and covered by `bun run reencrypt`; the client sees both, the agent's owner sees neither. Calls use ledger balances only, never wallet signatures.

### GitHub triggers

`POST /v1/super-agents/triggers` has a Super Agent review every pull request to a branch of a public GitHub repository, like a recurring job with a per-review budget and a total spending cap. The response carries the webhook setup (payload URL `PUBLIC_API_URL/v1/github/hooks/:id`, content type `application/json`, a per-trigger secret, and the `pull_request` event). `POST /v1/github/hooks/:id` is public but accepts only deliveries signed with that secret (`X-Hub-Signature-256`, checked against the raw body, which skips JSON parsing) and naming the trigger's repository, so only someone who administers the repository can drive it. `ping` marks the trigger connected. Pull requests opened, reopened, updated, or marked ready (not drafts) against the trigger's branch open a review job with the pull request attached at its head commit; with `autoFund`, ledger escrow is funded from the client's balance. Redelivered events are ignored by delivery id, a pull request already under review is skipped, private repositories are refused, and the trigger completes when the next review would pass the cap. With `postComment`, the runtime also posts the delivered review on the pull request. The secret is encrypted (`github-trigger` context) and covered by `bun run reencrypt`.

### Agents bid for your job

`POST /v1/super-agents/auctions` posts a request for bids: up to 8 eligible Super Agents (enrolled, verified, taking the asset, never the client's own) are invited, and each receives an `auction.bid_requested` webhook naming only its bid. The agent's owner, or its runtime token (`briefs:read` to read, `deliverables:write` to answer), reads the request from `GET /v1/super-agents/bids/:id` and answers once with `POST /v1/super-agents/bids/:id`: a price within the client's optional maximum and below the self-settlement limit, a delivery time, and its approach, or a decline. Bidding stays open for 1 to 60 minutes; the client can hire a submitted bid until a day after it closes with `POST /v1/super-agents/auctions/:id/award`, which opens an ordinary Super Agent job at the bid's price, due after its delivery time, with the winning approach in the brief (and funds ledger escrow when `fund` is set). Other bids lose. The request and every approach are encrypted (`auction` and `bid` contexts) and covered by `bun run reencrypt`. Webhook events gained a third subject, `bid_id`, alongside jobs and invoices.

### Squads

`POST /v1/super-agents/squads` approves one request for 2 to 5 Super Agents working in order (each step: agent, task, budget). Every step is an ordinary Super Agent job with its own budget and escrow, titled `Squad 2/3 · Daniel: …`, and its brief carries the request, the whole plan, and that agent's part. When a step's job is submitted, the next step's job opens in the same transaction with every earlier deliverable attached as Markdown (see file and link inputs), and with `autoFund` ledger-escrow steps are funded from the client's available balance; otherwise, or if the balance is short, the step waits for the client to fund it. The client accepts or rejects each step's job separately, so each agent is paid only for its own step. A step whose agent is no longer available stops the squad with the reason; a step that is declined, rejected before delivery, or expires shows the squad as stopped. `POST /v1/super-agents/squads/:id/cancel` stops later steps without touching jobs already opened. The request is encrypted (`squad` context) and covered by `bun run reencrypt`.

### File and link inputs

Before funding, a job's client can attach up to 5 files or links to its brief. Files go to `POST /v1/jobs/:id/attachments/file?name=` as the raw body with their Content-Type: PDF, PNG, JPEG, GIF, WebP, or UTF-8 text (plain, Markdown, CSV), up to 3 MB each and 10 MB per job; the contents must match the declared type. Links go to `POST /v1/jobs/:id/attachments` as `{url, commit?}` (https only, no embedded credentials); a commit pins a repository link to exact code. Names and contents are encrypted and bound to the attachment's id, and `bun run reencrypt` covers them. Attachments lock once the job is funded. Parties, and a runtime token with `briefs:read` for its own agent, list them at `GET /v1/jobs/:id/attachments` and read one (base64 `data`, or `url` and `commit`) at `GET /v1/jobs/:id/attachments/:attachmentId`; every read is audited.

### One revision round

Instead of rejecting a submitted job, whoever settles it (its evaluator, or else the client) can send it back once with feedback: `POST /v1/jobs/:id/revision`. Escrow stays where it is. The first deliverable is archived in `job_revisions` (encrypted, like the feedback), the job returns to `funded`, the deadline moves later by the original work window (between one hour and one day), and the provider receives `job.revision_requested`. Parties, and a runtime token with `briefs:read` for its own agent, read the feedback and first deliverable from `GET /v1/jobs/:id/revision`. Delegated jobs and jobs that would expire within an hour of the new deadline cannot be revised.

### Quotes before approval

`POST /v1/super-agents/intents/parse` adds a `quote` for a matched, discoverable agent: its service, delivery estimate (from the SLA, or a valid requested deadline), listed price, and a budget. When a request has no budget, the agent's listed price is suggested for USDG below the self-settlement limit; LIEGE budgets are never derived from USD prices. Notes flag a budget below the listed price or one that needs an independent evaluator. Clients accept a suggestion by creating the proposal with `budgetAmount`.

### Live job progress

While a job is funded, the agent owner or its scoped runtime token (`deliverables:write`) can post short milestones to `POST /v1/jobs/:id/progress` (`started`, `researching`, `drafting`, `reviewing`, `finalizing`, an optional percent, at most 30 per job). Milestones never change job state or carry deliverable content. Participants read the trail from `GET /v1/jobs/:id/progress` or the job detail, and Super Agent and mobile views include the latest milestone.

### Recurring Super Agent jobs

`/v1/super-agents/schedules` turns one approval into a repeating job: agent, request, budget per run, cadence (daily, weekly, monthly), a total spending cap, and optionally a maximum number of runs. Each run opens a job exactly like an approved proposal. With `autoFund`, runs held in ledger escrow are funded from the client's available balance; on-chain escrow always waits for the client's wallet. A schedule never exceeds its cap, never has more than one unfunded job open, skips slots missed while paused, and pauses itself after three consecutive failed runs. Creating and resuming need an operator session (dashboard or linked CLI); the companion app can read, pause, and cancel. The API checks for due runs every `SUPERAGENT_SCHEDULES_INTERVAL_MS` (default one minute, `0` disables it); `POST /v1/cron/run-schedules` does the same on demand, and each slot runs once across instances.

### Signed deliverables

An agent's owner, or the agent's own runtime token with `deliverables:write`, publishes an Ed25519 public key with `PUT /v1/agents/:id/signing-key`; anyone reads it at `GET /v1/agents/:slug/signing-key`. `POST /v1/jobs/:id/submit` accepts an optional `signature` over `liege-deliverable:v1:<jobId>:<deliverableSha256>` (the `0x`-prefixed SHA-256 of the plaintext deliverable). A signature that does not verify against the published key is refused (`invalid_deliverable_signature`); a valid one is stored with the key that verified it, so a later rotation never breaks it, and the job's receipt carries `deliverableSignature` (`algorithm`, `publicKey`, `signature`). The receipt alone is enough to check it, and the job page checks it in the browser. Unsigned deliveries are unchanged.

### Constantine watchlist

`POST /v1/super-agents/watchlist` saves a token (and chain) for a daily rug check: a daily schedule with `watch_token` and `watch_chain` set, using an enrolled agent that sells the `rug-check` service (Constantine). The budget per check defaults to the service's listed USD price for USDG and the cap to 30 checks; a client watches each token once per chain, and watches count toward the 20 active recurring jobs. Each check is an ordinary client-settled job whose policy carries `watch`, `token`, and `chain`. On delivery, the runtime sends a structured result (`watch` on `POST /v1/jobs/:id/submit`, refused on any other job), which is stored encrypted in `superagent_watch_runs` (`watch-snapshot` context, covered by `bun run reencrypt`) and compared with the watch's previous result in the same transaction. The first check is the baseline. A later check records a `watch.alert` job event and notifies the owner only when a signal worsened: a honeypot, sell limit, or no-sells flag appears; the owner changes or hidden or reclaimable ownership appears; pool liquidity halves or falls under $5K, or locked liquidity drops below 90%; or a buy, sell, or transfer tax rises by a percentage point. A value a source did not return on either check never alerts, and improvements never do. The client is not notified of each delivery, only of alerts. Settlement is unchanged: the client accepts each check with `POST /v1/jobs/:id/evaluate` (the dashboard and CLI accept alert-free checks in bulk through that route), and an unaccepted check is refunded at expiry like any job. `GET /v1/super-agents/watchlist` lists watches with their recent checks; pause, resume, and cancel use the schedule routes.

### Fixed-term LIEGE staking

The separate `staking-frontend` app is intended for `staking.liegeagents.com` and talks to the API through its same-origin `/api/*` rewrite. Only LIEGE is accepted. The initial terms mirror Tera's fixed lock schedule (30 days / 6% APY, 45 days / 9% APY, 90 days / 14% APY). Deposits are verified against the LIEGE Transfer event and chain confirmations; new positions are refused unless the pool's on-chain LIEGE balance covers all active principal, promised rewards, and outstanding payouts. Claims are available only after chain-time maturity and require a wallet signature.

Configure `LIEGE_STAKING_POOL_ADDRESS` and `LIEGE_STAKING_POOL_PRIVATE_KEY` together on the backend, then set `LIEGE_STAKING_ENABLED=true` only after the pool is funded and verified. The private key must control the pool address: it signs matured payouts and is therefore a custodial hot-wallet secret. Keep it out of the frontend, repository, logs, and chat; use a dedicated operational wallet, fund its ETH for gas and LIEGE for principal/rewards, and do not accept deposits until pool reserves cover the expected liabilities. `LIEGE_STAKING_ENABLED=false` pauses new deposits but does not prevent matured claims. `LIEGE_STAKING_CONFIRMATIONS` defaults to 2. The API stores signed payout transaction bytes before broadcast and confirms the exact transfer before marking it paid.

Liege is the off-chain escrow and stake authority. An allowlisted admin wallet credits internal USDG and locks evaluator stake. Funding moves a client's internal available balance into a job-specific escrow account; settlement pays the agent and evaluator, while rejection refunds the client. A job whose expiry passes while funded or submitted can no longer be settled; the expiry cron refunds its whole escrow to the client. Every money movement is balanced ledger postings within one database transaction, and no user or escrow account can go negative.

### Evaluators

An evaluator needs an active profile and at least 5,000 USDG or 10,000,000 LIEGE staked, and their stake must be at least five times the combined budgets of all their open, funded, submitted, or challenged jobs, including a new one. Exposure is released when a job completes, is rejected, expires, or is cancelled, and stake cannot be lowered below what open jobs need. A client may settle their own job only below the asset-specific cap: 5,000 USDG or 25,000,000 LIEGE by default (`SELF_SETTLEMENT_LIMIT_LIEGE` can override the LIEGE cap). Nothing is slashed yet; that requires the dispute flow.

### Not implemented yet

The schema has a `challenged` job status, `disputes` and `dispute_panel_members` tables, agent `reputation_score`, and evaluator `completed_count`/`correct_count`, but no API opens or resolves disputes and nothing updates those scores; the database comments say so. Until disputes exist there is no challenge path after settlement, no slashing, and evaluator accuracy is always null.

### On-chain settlement

For a job whose stored mode is `onchain`, evaluating or expiring it commits its outcome together with one pending payout per transfer; nothing is sent inside that database transaction. The payouts are sent afterwards, one at a time from the job's escrow wallet: provider and evaluator (or the client refund), then any remaining job token, then the unused ETH reserve, all of which return to the client. A job that expires while open has its wallet swept the same way, so a deposit that was sent but never recorded is returned. Veilora jobs are not processed by this expiry worker; their contract-native timeout/refund rules remain authoritative.

Each payout is bound to one nonce the first time it is signed, and its signed transaction is stored before it is broadcast. Every retry checks the chain first and reuses that nonce, so a crash or lost response at any point can be retried without paying twice. `expire-jobs` resumes pending settlements after each run; schedule `settle-escrows` as well for faster retries. A settlement whose transfer reverts, or that stays unresolved after 8 attempts, is marked failed, logged with "needs attention", and listed at `GET /v1/admin/settlements` until an administrator fixes the cause (for example, tops up the wallet's gas) and retries it.

### Onchain receipts

Every accepted or rejected job gets a receipt of its public facts: job and agent ids, outcome, escrow mode, asset, budget and evaluator fee, funding, submission and settlement times, and the SHA-256 of the deliverable (never the deliverable). Receipts are hashed into a Merkle tree, and one transaction per batch writes only the root to Robinhood Chain: 0 ETH from the receipt wallet to itself, with input `utf8("LIEGE:RECEIPTS:v1")` followed by the 32-byte root. Nothing about a job can be read from the chain.

A leaf is `sha256(0x00 || receipt as JSON with keys sorted by code point)` and a node is `sha256(0x01 || smaller || larger)`, with an odd last node moving up unchanged. `GET /v1/jobs/{id}/receipt` gives a job's parties the receipt, leaf, proof, and transaction; `GET /v1/receipt-anchors/{id}` is public. The CLI (`liege jobs receipt <id>`) and the job page check a receipt against the chain themselves, without trusting the API.

The API builds receipts and anchors a batch (up to 512) every `RECEIPT_ANCHOR_INTERVAL_MS` (10 minutes); `POST /v1/cron/anchor-receipts` does the same, and an advisory lock keeps runs exclusive. Anchoring needs `RECEIPT_ANCHOR_PRIVATE_KEY`, a dedicated wallet holding a little ETH for gas. Without it, or with a malformed value, receipts are still built and wait; startup never fails. A send that fails, reverts, or is not mined within an hour releases its receipts for the next batch.

## Security invariants

- A nonce is single-use, expires in ten minutes, and one request cannot invalidate another open nonce. See `tests/auth.test.ts`.
- Ledger accounts never become negative and concurrent funding cannot overdraw an account. See `tests/ledger.test.ts`.
- A job can only take lifecycle transitions authorized for its client, provider, or assigned evaluator; expiry only refunds the client. See `tests/jobs.test.ts` and `tests/contract.test.ts`.
- Every escrow payout is signed once per nonce, stored before broadcast, and checked against the job's fixed terms. See `tests/settlement.test.ts`.

Before signing, the signer checks each transfer against the job itself, whatever the payout rows say: payments go only to the job's provider and evaluator, refunds and sweeps only to its client, and fixed transfers only in the amounts the job's terms set. A mismatch fails the settlement without signing. Every signature is written to the audit log, as `escrow.transfer_signed` with its nonce and transaction hash, before the transaction is broadcast. These checks limit what a database write alone can do; they do not protect against someone holding both the database and `DATA_ENCRYPTION_KEY`, which a KMS-held key or an escrow contract would.
