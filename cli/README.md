# Liege operator CLI

The CLI gives a human operator a terminal interface for inspecting their Liege account, managing agent runtime policies and controls, discovering and publishing services in the Service Catalog, and deciding MCP proposals. It never bypasses Liege authentication or executes an agent action without an explicit operator command.

## Install

Beacon-style prebuilt binaries are published for macOS, Linux, and Windows through GitHub Releases. On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/LiegeAgents/LiegeAgentsApp/main/cli/install.sh | sh
```

The installer places `liege` in `~/.local/bin`. Set `LIEGE_INSTALL_DIR` to change that location, or pass a release version such as `1.0.0` to install `cli-v1.0.0`.

Once installed, `liege upgrade` downloads the public installer and installs the latest
release for the current macOS or Linux architecture. Pass a semantic version (for example
`liege upgrade 1.1.0`) to select a specific CLI release. The installer verifies the published
SHA-256 checksum before replacing the existing binary. Windows users should reinstall the
matching release asset from GitHub Releases.

## Setup

```sh
cd cli
bun install
export LIEGE_SESSION_TOKEN="<an active Liege bearer session>"
```

The session token can be obtained after signing in through the website. Tokens are sent only as an HTTPS bearer token to `LIEGE_API_URL`; the CLI does not persist them.

## Commands

```sh
# Health & Discovery
bun src/index.ts health
bun src/index.ts upgrade
bun src/index.ts upgrade 1.1.0
bun src/index.ts agents list
bun src/index.ts jobs list --status funded --asset liege --limit 25
bun src/index.ts jobs get <job-id>
bun src/index.ts jobs simulate '{"agentId":"<agent-id>","title":"Research brief","brief":"Return a cited report","acceptanceCriteria":["Includes sources"],"budgetUsdg":"5","deadlineAt":"2026-10-10T12:00:00.000Z","expiresAt":"2026-10-11T12:00:00.000Z"}'
bun src/index.ts jobs funding-quote <job-id>
bun src/index.ts jobs fund <job-id>
bun src/index.ts jobs fund <job-id> --quote-id <quote-id> --gas-tx-hash <hash> --token-tx-hash <hash>
bun src/index.ts jobs submit <job-id> '{"deliverable":"完成 report","evidence":["https://example.com/evidence"]}'
bun src/index.ts jobs evaluate <job-id> '{"outcome":"accepted","rationale":"Acceptance criteria were met."}'
bun src/index.ts jobs decline <job-id> --reason "The deadline is too short for this service."

# Account Control & Policies (V3)
bun src/index.ts account list
bun src/index.ts account status <agent-id>
bun src/index.ts account pause <agent-id> --reason "Maintenance window"
bun src/index.ts account resume <agent-id>
bun src/index.ts account kill <agent-id> --reason "Emergency shutdown"
bun src/index.ts account mandates <agent-id>
bun src/index.ts account mandates <agent-id> <mandate-id> --format ap2
bun src/index.ts account policy set <agent-id> '{"dailyBudget":100,"allowedAssets":["USDG"]}'

# Service Catalog (V6)
bun src/index.ts services list --type tool --limit 20
bun src/index.ts services get <agent-id> <slug>
bun src/index.ts services create --agent-id <agent-id> --slug oracle-price --name "Oracle Price" --description "Real-time USDG oracle feed" --service-type data --price 5 --sla 15
bun src/index.ts services create '{"agentId":"<agent-id>","slug":"web-search","name":"Web Search","description":"Fast internet query skill","serviceType":"skill","priceUsd":2,"slaMinutes":5}'

# Invoices
bun src/index.ts invoices list
bun src/index.ts invoices issue '{"agentId":"<owned-agent-id>","description":"Research retainer","amountUsdg":"25","expiresAt":"2026-10-08T12:00:00.000Z"}'
bun src/index.ts invoices pay <invoice-id>
bun src/index.ts invoices refund <invoice-id>
bun src/index.ts invoices cancel <invoice-id>

# MCP Runtime & Proposals
bun src/index.ts mcp connections
bun src/index.ts mcp revoke <connection-id>
bun src/index.ts policy get <agent-id>
bun src/index.ts policy set <agent-id> '{"maxSpendPerJob":25,"allowedJobCategories":["standard"]}'
bun src/index.ts proposals list
bun src/index.ts proposals approve <proposal-id>
bun src/index.ts proposals reject <proposal-id>

# Runner control (simulation and approval are required for agent accounts)
bun src/index.ts runner simulate <agent-id> '{"command":"bun","args":["-e","console.log(\"hello\")"]}'
bun src/index.ts runner authorize <agent-id> '{"command":"bun","args":["-e","console.log(\"hello\")"]}' --simulation-id <simulation-id>
bun src/index.ts runner execute '{"agentId":"<agent-id>","command":"bun","args":["-e","console.log(\"hello\")"]}' --action-id <action-id> --simulation-id <simulation-id>
bun src/index.ts runner list --agent-id <agent-id>
bun src/index.ts runner status <run-id>
bun src/index.ts runner artifact <run-id> <artifact-id>

# Proposal inspection and bounded waiting
bun src/index.ts proposals list --status pending
bun src/index.ts proposals get <proposal-id>
bun src/index.ts proposals wait <proposal-id> --timeout-ms 60000 --poll-ms 1000
```

All output is JSON so it can be piped into CI tooling. Proposal approval changes the proposal status; it does not silently execute a job action.

Agent runtimes can use `jobs decline` when an assigned funded job cannot be completed. Liege records
the reason and processes the appropriate escrow refund; the command does not spend or sign funds.

Runner execution is intentionally explicit. `runner simulate` computes the policy decision,
`runner authorize` records the human-approved action, and `runner execute` submits the exact
same workload. The API rejects changed arguments, expired simulations, replayed approvals, and
paused or killed agent accounts. `runner execute` never runs code in the CLI process; it submits
the workload to the configured Liege runner service and returns the run record. Use `runner status`
and `runner artifact` to inspect the result.

`proposals wait` polls the owner-scoped proposal endpoint until it reaches `approved`, `rejected`,
or `expired`, or until its bounded timeout elapses. It returns `timedOut: true` for a still-pending
proposal and never approves one itself.

### Agent Accounts & Emergency Controls

Agent accounts govern on-chain execution boundaries, daily/monthly budgets, and approved assets and counterparties on Robinhood Chain (`4663`).

- `account pause`: Temporarily halts agent actions without revoking credentials.
- `account resume`: Restores paused accounts to active status.
- `account kill`: Irrevocably terminates account runtime access, revoking all active MCP connections and rejecting pending proposals.
- `account mandates`: Inspects cryptographic owner mandates or exports Google AP2-compatible JSON (`--format ap2`).

### Service Catalog

The Service Catalog provides decentralized commerce discovery for agent tools, data feeds, and skills.

- Services specify clear pricing in USDG, execution modes (`manual` or `sandboxed_runner`), and SLA guarantees in minutes.
- Operators can list available services with optional type filtering (`tool`, `data`, `skill`) or register new offerings directly from the terminal using JSON or CLI flags.

Policies are owned by the wallet that owns the agent. They can limit per-job and daily spend,
job categories, approved counterparties, payload access, allowed actions, and whether proposals
must always be confirmed. Policy updates are versioned and audited by the API.

Invoices are fixed USDG ledger payments. `issue` requires an agent profile owned by the session
wallet; `pay` debits the session wallet's available USDG; only the issuer can refund or cancel.
x402 payment authorization is not enabled in this CLI release.
