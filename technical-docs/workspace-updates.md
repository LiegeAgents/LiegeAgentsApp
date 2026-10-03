# Workspace dashboard updates

This document tracks the remaining dashboard improvements after the Job Activity Timeline.

## Completed

### Job Activity Timeline

The job detail view now presents a chronological lifecycle summary using the existing job
timestamps:

- Job opened
- Escrow funded
- Delivery submitted
- Evaluation outcome
- Escrow settled or job expired

The timeline is role-scoped by the existing private job-detail endpoint. It does not expose
briefs, deliverables, evaluator rationale, or execution metadata to users who cannot already
access that job.

## Remaining workspace updates

### 1. Agent accounts and mandates

Add an account control panel for each owned agent. It should show:

- Account status: active, paused, or killed
- Available and reserved balances by settlement asset
- Spend limits and approval thresholds
- Active mandates and their expiry
- A clear kill-switch control with confirmation

The panel should use the existing agent-account and mandate endpoints. Destructive controls must
require an explicit confirmation and should display the resulting audit event.

### 2. Execution observability

Add a job-scoped observability view for runner-backed work. Show metadata only:

- Run status and timestamps
- Runtime duration and exit code
- Tool-call or trace-event count
- Retry count and decision checkpoints
- Captured artifact names and download state
- Outcome metrics that do not reveal private task content

The existing execution trace and artifact APIs remain the source of truth. Payload text, secrets,
commands containing secrets, and encrypted briefs must not be rendered in this view.

### 3. MCP connection health

Add a connection-health section to Workspace settings with:

- Linked agent profile
- Connection name and token expiry
- Active or revoked status
- Last-seen or last-used information when available
- Proposal activity summary
- Revoke action and confirmation

Tokens must remain hidden after creation. The dashboard should link to the MCP documentation and
make it clear that each token is scoped to one agent profile.

### 4. Workspace notifications

Add a unified notifications center for owner-scoped attention items:

- Pending MCP and runner approvals
- Jobs approaching their deadline or expiry
- Invoices awaiting payment or nearing expiry
- Evaluations awaiting review
- Failed runner executions
- Settlement and refund outcomes

Notifications should deep-link to the relevant workspace view, show when they were last refreshed,
and avoid marking an item resolved until the underlying API state confirms the change.

## Delivery order

1. Agent accounts and mandates
2. MCP connection health
3. Execution observability
4. Workspace notifications

This order puts capital controls and access visibility ahead of convenience features. Each update
should remain compatible with the client-only workspace architecture and should degrade gracefully
when the user is not signed in or the API is unavailable.
