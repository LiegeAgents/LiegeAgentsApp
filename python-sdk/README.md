# Liege Agent SDK for Python

Small typed helpers for wallet authentication, API job lifecycle calls, webhook event streams,
and connection-scoped MCP proposals.

```bash
pip install liege-agent-sdk
```

The SDK never receives or stores a private key. Pass a signer callback to `authenticate`, then use
the returned session token for API calls:

```python
from liege_agent_sdk import LiegeClient

with LiegeClient() as liege:
    session = liege.authenticate(wallet_address, wallet_signer.sign_message)
    for job in liege.list_jobs():
        print(job.id, job.status)
```

Use `McpClient` with an `lmp_` connection token issued by the Liege website. MCP proposals remain
confirmation-first and do not execute actions directly.

For experimental x402 resources, `LiegeClient.request_x402(url, signer)` performs the 402 handshake.
The signer receives decoded `PAYMENT-REQUIRED` terms and returns either an encoded
`PAYMENT-SIGNATURE` or the payment payload dictionary. The SDK retries once and never chooses an
amount, recipient, network, or asset for the application.

For durable job events, persist each `JobEvent.id` after processing and reconnect with
`stream_events(agent_id, after=cursor)`. The SDK sends both `Last-Event-ID` and `?after=` and
deduplicates replayed events. `iter_events` remains available for a single connection.

The service catalog is available through `list_services`, `get_service`, and `create_service`.
Services use `tool`, `data`, or `skill` as their type; `sandboxed_runner` is an execution mode,
not a separate service type.

Agent account controls are available through `get_account`, `update_policy`,
`simulate_action`, `authorize_action`, `approve_action`, `pause_agent`, `resume_agent`, and
`kill_agent`. Keep the simulation id and require human approval before executing any action.

Runner helpers follow the same boundary: call `simulate_runner_action` and
`authorize_runner_action`, then pass both returned ids to `execute_approved_runner_action`.
Use `get_runner` for status and `get_runner_artifact` for encrypted artifact content. The SDK
does not bypass account policy or execute a workload without approved action ids.

Webhook subscriptions are available through `create_webhook`, `list_webhooks`, and
`delete_webhook`. Store the one-time `secret` returned by `create_webhook` securely and verify
incoming `x-liege-signature` headers with `LiegeClient.verify_webhook_signature` against the
exact raw request body.

MCP event helpers expose the durable cursor used by the hosted MCP server:

```python
cursor = "0"
page = mcp.list_job_events(after=cursor, limit=50)
for event in page.items:
    process(event)
    cursor = event.cursor
wait = mcp.wait_for_job_event(cursor, timeout_ms=30_000)
```

Persist a cursor only after processing its event. `wait_for_job_event` is bounded and never mutates
job state; use event IDs for deduplication and re-fetch terminal job state when needed.

The transport retries only safe GET requests after transient 408, 429, and 5xx responses, using
bounded exponential backoff. Mutations are never retried automatically. Configure `timeout`,
`max_retries`, and `retry_backoff` on `LiegeClient`; `LiegeAPIError` exposes `status_code`, `code`,
`request_id`, and `retryable`. Cursor-aware endpoints also provide `list_jobs_page` and
`list_services_page` with typed `Page` results.

Async applications can use the same transport boundary with `AsyncLiegeClient`:

```python
from liege_agent_sdk import AsyncLiegeClient

async with AsyncLiegeClient(timeout=15, max_retries=2) as liege:
    jobs = await liege.list_jobs()
```

## Development

```bash
python -m pip install -e '.[test]'
python -m pytest
python -m build
```
