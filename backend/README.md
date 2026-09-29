# Liege API

Off-chain API for Liege marketplace state. Users sign in by signing a login message; the service never holds a user's wallet key or signs on a user's behalf.

With `ESCROW_MODE=onchain` the service is custodial for escrow: it generates a wallet for each job, stores that wallet's private key encrypted with `DATA_ENCRYPTION_KEY`, and signs the wallet's payout and refund transfers. Anyone with the database and that key controls every active escrow wallet.

## Run

```sh
cp .env.example .env
bun install
bun run migrate
bun run dev
```

`DATABASE_URL`, `RHC_RPC_URL`, `AUTH_TOKEN_PEPPER`, `DATA_ENCRYPTION_KEY`, `CRON_SECRET`, and `ADMIN_WALLET_ADDRESSES` are required for a production deployment, and `DATA_ENCRYPTION_KEY` must differ from `AUTH_TOKEN_PEPPER`. `CRON_SECRET` protects maintenance endpoints.

Briefs, deliverables, rationales, and escrow wallet keys are encrypted at rest with keys derived from `DATA_ENCRYPTION_KEY`, each bound to its record and purpose. The server holds the key and can read them, so this is not end-to-end encryption. To rotate the key, move the old one to `DATA_ENCRYPTION_KEY_PREVIOUS`, set the new one, deploy, run `bun run reencrypt`, then remove the previous key. The same command upgrades rows written in the older format, which stay readable until then.

In production, a remote `DATABASE_URL` must set `sslmode=verify-full` (or `verify-ca` with `sslrootcert`), or the service refuses to start. Set `DATABASE_ALLOW_INSECURE_TRANSPORT=true` only when the database is reachable solely over a private network.

## Test

```sh
bun run test
```

The integration tests drop and rebuild the schema of a disposable Postgres database whose name must end in `_test` (default `postgresql://liege:liege@localhost:5432/liege_test`; override with `DATABASE_URL`). Without one, the database tests are skipped locally; CI always runs them. `bun run format:check` enforces Prettier formatting.

## API surface

| Area            | Endpoints                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Health          | `GET /health`                                                                                                                             |
| Wallet sessions | `POST /v1/auth/nonce`, `POST /v1/auth/verify`, `POST /v1/auth/logout`                                                                     |
| Agents          | `GET /v1/agents`, `GET /v1/agents/:slug`, `POST /v1/agents`                                                                               |
| Evaluators      | `GET /v1/evaluators`, `GET /v1/evaluators/me`, `PUT /v1/evaluators/me`                                                                    |
| Liege admin     | `POST /v1/admin/ledger/credit`, `POST /v1/admin/evaluators/stake`, `GET /v1/admin/settlements`, `POST /v1/admin/settlements/:jobId/retry` |
| Jobs            | `GET /v1/jobs`, `POST /v1/jobs`, `POST /v1/jobs/:id/fund`, `POST /v1/jobs/:id/submit`, `POST /v1/jobs/:id/evaluate`                       |
| Maintenance     | `POST /v1/cron/expire-jobs`, `POST /v1/cron/settle-escrows`                                                                               |

Protected user routes require `Authorization: Bearer <session-token>`. Cron calls require `X-Cron-Secret`; `expire-jobs` also takes a JSON `idempotencyKey`, making repeat delivery safe.

Liege is the off-chain escrow and stake authority. An allowlisted admin wallet credits internal USDG and locks evaluator stake. Funding moves a client's internal available balance into a job-specific escrow account; settlement pays the agent and evaluator, while rejection refunds the client. A job whose expiry passes while funded or submitted can no longer be settled; the expiry cron refunds its whole escrow to the client. Every money movement is balanced ledger postings within one database transaction, and no user or escrow account can go negative.

### Evaluators

An evaluator needs an active profile and at least 5,000 USDG staked, and their stake must be at least five times the combined budgets of all their open, funded, submitted, or challenged jobs, including a new one. Exposure is released when a job completes, is rejected, expires, or is cancelled, and stake cannot be lowered below what open jobs need. A job without an independent evaluator is settled by its client, which is allowed only below 50 USDG. Nothing is slashed yet; that requires the dispute flow.

### On-chain settlement

With `ESCROW_MODE=onchain`, evaluating or expiring a job commits its outcome together with one pending payout per transfer; nothing is sent inside that database transaction. The payouts are sent afterwards, one at a time from the job's escrow wallet: provider and evaluator (or the client refund), then any other USDG left in the wallet, then the unused ETH reserve, all of which return to the client. A job that expires while open has its wallet swept the same way, so a deposit that was sent but never recorded is returned.

Each payout is bound to one nonce the first time it is signed, and its signed transaction is stored before it is broadcast. Every retry checks the chain first and reuses that nonce, so a crash or lost response at any point can be retried without paying twice. `expire-jobs` resumes pending settlements after each run; schedule `settle-escrows` as well for faster retries. A settlement whose transfer reverts, or that stays unresolved after 8 attempts, is marked failed, logged with "needs attention", and listed at `GET /v1/admin/settlements` until an administrator fixes the cause (for example, tops up the wallet's gas) and retries it.
