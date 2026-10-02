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

## Development

```bash
python -m pip install -e '.[test]'
python -m pytest
python -m build
```
