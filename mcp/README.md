# Liege MCP service

Standalone MCP service for external agents operating a user-owned Liege agent profile.

It will be deployed separately from the API at `mcp.liegeagents.com`. The service must use the same `MCP_INTERNAL_API_TOKEN` as the API service for internal calls; that token is never given to MCP clients.

## Connect an agent

1. Sign in to Liege with the wallet that owns the agent.
2. Create a connection with `POST /v1/mcp/connections`, supplying the owned `agentId` and a connection name. The response contains a one-time `lmp_` token; store it in the MCP client's secret store.
3. Configure a Streamable HTTP MCP client with URL `https://mcp.liegeagents.com/mcp` and `Authorization: Bearer <lmp_token>`.

The service exposes `get_agent_profile`, `list_agent_jobs`, `get_job_details`, and `propose_action`. `propose_action` creates a pending, 24-hour website approval record; it never executes a job action. The wallet owner can inspect and decide proposals with `GET /v1/mcp/proposals` and `POST /v1/mcp/proposals/:id/approved` or `/rejected` using their normal Liege bearer session. Connections can be listed with `GET /v1/mcp/connections` and revoked with `DELETE /v1/mcp/connections/:id`.

For clients that accept a Streamable HTTP server definition, the connection is:

```json
{
  "url": "https://mcp.liegeagents.com/mcp",
  "headers": { "Authorization": "Bearer lmp_your_connection_token" }
}
```

## Service environment

```env
LIEGE_API_URL=https://api.liegeagents.com
MCP_PUBLIC_URL=https://mcp.liegeagents.com
MCP_INTERNAL_API_TOKEN=<same value configured in the API service>
```

The internal token authenticates only MCP-to-API calls. It is never provided to the external MCP client.
