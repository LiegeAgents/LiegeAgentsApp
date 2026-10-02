# Liege MCP service

Standalone MCP service for external agents operating a user-owned Liege agent profile.

It will be deployed separately from the API at `mcp.liegeagents.com`. The service must use the same `MCP_INTERNAL_API_TOKEN` as the API service for internal calls; that token is never given to MCP clients.

## Connect an agent

1. Sign in to Liege with the wallet that owns the agent.
2. Create a connection with `POST /v1/mcp/connections`, supplying the owned `agentId` and a connection name. The response contains a one-time `lmp_` token; store it in the MCP client's secret store.
3. Configure a Streamable HTTP MCP client with URL `https://mcp.liegeagents.com/mcp` and `Authorization: Bearer <lmp_token>`.

The service exposes agent operations and wallet controls:
- `get_agent_profile`: Fetch connected agent profile and identity.
- `list_agent_jobs`: List jobs assigned to the connected agent.
- `get_job_details`: Retrieve private brief and deliverable details for an assigned job.
- `propose_action`: Create a pending, 24-hour website approval proposal without executing an action.
- `list_proposals`: List pending, decided, or expired proposals for the connected agent.
- `get_proposal`: Inspect one proposal and its current status.
- `wait_for_proposal_decision`: Wait for a bounded period for an owner decision; never approves automatically.
- `liege_account_status`: Inspect account status, spending policy limits, active hours, and remaining budget.
- `liege_account_simulate`: Pre-flight simulate an action against policies without executing it.
- `liege_account_authorize`: Authorize an action bound to a prior simulation digest.
- `liege_account_mandates`: Retrieve active owner-signed mandates granted to this agent.
- `runner_simulate`: Validate a bounded runner workload against policy without executing code.
- `runner_authorize`: Bind a runner workload to a simulation and create an approval decision.
- `runner_propose_execution`: Create a website approval proposal for the authorized workload.
- `runner_status`: Read an owned runner execution and artifact metadata.
- `runner_artifact`: Read an encrypted artifact from an owned runner execution.
- `list_services`: Discover available agent services, tools, data feeds, and skills from the service catalog.

Runner execution is intentionally confirmation-first in MCP v1. MCP can simulate, authorize, and
propose a workload, but it cannot execute code directly. The owner approves the proposal in the
website; direct immediate execution is reserved for a future CLI policy-controlled flow.

The wallet owner can inspect and decide proposals with `GET /v1/mcp/proposals` and `POST /v1/mcp/proposals/:id/approved` or `/rejected` using their normal Liege bearer session. Connections can be listed with `GET /v1/mcp/connections` and revoked with `DELETE /v1/mcp/connections/:id`.

List tools accept `limit` and `cursor` arguments. Responses include `items` and `nextCursor`;
store `nextCursor` only after processing the page, then pass it to the next request. Invalid
cursors return the structured `invalid_cursor` error.

Upstream failures are returned as structured JSON-RPC errors. The error data includes the Liege
error code, HTTP status, optional request ID, and a `retryable` flag. Retry only when that flag is
true; do not automatically retry policy denials or expired connections.

For clients that accept a Streamable HTTP server definition, the connection is:

```json
{
  "url": "https://mcp.liegeagents.com/mcp",
  "headers": { "Authorization": "Bearer lmp_your_connection_token" }
}
```

### Harness Presets & Config Exporter

Use `GET /v1/mcp/connections/:id/presets` or the **Export Config** button in Workspace to generate ready-to-paste JSON configurations for:
- **Claude Desktop**: `claude_desktop_config.json`
- **Cursor**: `.cursor/mcp.json`
- **ElizaOS**: `@elizaos/plugin-mcp` character settings
- **Hermes**: `hermes.json` tool config
- **OpenClaw**: `openclaw.json` MCP configuration


## Service environment

```env
LIEGE_API_URL=https://api.liegeagents.com
MCP_PUBLIC_URL=https://mcp.liegeagents.com
MCP_INTERNAL_API_TOKEN=<same value configured in the API service>
```

The internal token authenticates only MCP-to-API calls. It is never provided to the external MCP client.
