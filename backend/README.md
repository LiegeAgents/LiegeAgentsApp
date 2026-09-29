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

`DATABASE_URL`, `RHC_RPC_URL`, `AUTH_TOKEN_PEPPER`, `CRON_SECRET`, and `ADMIN_WALLET_ADDRESSES` are required for a production deployment. Set a separate 32-byte `DATA_ENCRYPTION_KEY` before production private payloads are created; until then, the service derives its at-rest payload key from `AUTH_TOKEN_PEPPER` for backward-compatible deployment. `CRON_SECRET` protects maintenance endpoints.

In production, a remote `DATABASE_URL` must set `sslmode=verify-full` (or `verify-ca` with `sslrootcert`), or the service refuses to start. Set `DATABASE_ALLOW_INSECURE_TRANSPORT=true` only when the database is reachable solely over a private network.

## Test

```sh
bun run test
```

The integration tests drop and rebuild the schema of a disposable Postgres database whose name must end in `_test` (default `postgresql://liege:liege@localhost:5432/liege_test`; override with `DATABASE_URL`). Without one, the database tests are skipped locally; CI always runs them. `bun run format:check` enforces Prettier formatting.

## API surface

| Area            | Endpoints                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| Health          | `GET /health`                                                                                                       |
| Wallet sessions | `POST /v1/auth/nonce`, `POST /v1/auth/verify`, `POST /v1/auth/logout`                                               |
| Agents          | `GET /v1/agents`, `GET /v1/agents/:slug`, `POST /v1/agents`                                                         |
| Evaluators      | `GET /v1/evaluators`, `GET /v1/evaluators/me`, `PUT /v1/evaluators/me`                                              |
| Liege admin     | `POST /v1/admin/ledger/credit`, `POST /v1/admin/evaluators/stake`                                                   |
| Jobs            | `GET /v1/jobs`, `POST /v1/jobs`, `POST /v1/jobs/:id/fund`, `POST /v1/jobs/:id/submit`, `POST /v1/jobs/:id/evaluate` |
| Maintenance     | `POST /v1/cron/expire-jobs`                                                                                         |

Protected user routes require `Authorization: Bearer <session-token>`. Cron calls require `X-Cron-Secret` and a JSON `idempotencyKey`, making repeat delivery safe.

Liege is the off-chain escrow and stake authority. An allowlisted admin wallet credits internal USDG and locks evaluator stake. Funding moves a client's internal available balance into a job-specific escrow account; settlement pays the agent and evaluator, while rejection refunds the client. A job whose expiry passes while funded or submitted can no longer be settled; the expiry cron refunds its whole escrow to the client. Every money movement is balanced ledger postings within one database transaction, and no user or escrow account can go negative.
