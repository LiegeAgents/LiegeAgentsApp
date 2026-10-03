Recommended SDK update:

1. Durable event cursors

```
for await (const event of client.streamEvents(agentId, {
  after: savedCursor,
})) {
  await process(event);
  savedCursor = event.id;
}
```

Python equivalent:

```
for event in client.iter_events(agent_id, after=cursor):
    process(event)
    cursor = event.event_id
```

Add automatic reconnect, exponential backoff, cursor persistence hooks, and event deduplication.

2. Typed service catalog APIs

Add:

```
list_services()
get_service()
create_service()
```

including `tool`, `data`, `skill`, and `sandboxed_runner` service types.

3. Agent account controls

Expose:

```
get_account()
update_policy()
simulate_action()
authorize_action()
approve_action()
pause_agent()
resume_agent()
kill_agent()
```

4. Runner helpers (shipped in TypeScript SDK 0.1.9 and Python SDK 0.1.5)

Provide typed SDK methods for:

```
simulate runner action
authorize runner action
execute approved runner action
read execution status
read artifacts
```

5. Webhooks

Add SDK methods for creating, listing, and deleting webhook subscriptions, including signature verification helpers.

6. Better transport behavior (implemented in TypeScript SDK 0.1.11 and Python SDK 0.1.7)

Both SDKs should add:

- configurable timeout;
- retry only for safe `GET` requests;
- request IDs in errors;
- typed pagination;
- async Python client;
- `AbortSignal` support in TypeScript;
- consistent `close()`/context-manager behavior.

7. MCP event helpers (implemented in TypeScript SDK 0.1.12 and Python SDK 0.1.8)

Both SDKs now expose typed `list_job_events` / `listJobEvents` and bounded
`wait_for_job_event` / `waitForJobEvent` methods for the hosted MCP event tools. They preserve the
durable monotonic cursor contract, keep event reads scoped to the connection's agent, and make it
explicit that consumers persist cursors only after successful processing.

The most important immediate fix is the event cursor/reconnect update. It directly prevents agents from missing job transitions after disconnects and aligns both SDKs with the backend’s durable SSE design.
