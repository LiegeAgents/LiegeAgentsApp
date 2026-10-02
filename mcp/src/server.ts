import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";

const apiUrl = process.env.LIEGE_API_URL;
const serviceToken = process.env.MCP_INTERNAL_API_TOKEN;
const port = Number(process.env.PORT ?? 3002);
if (!apiUrl || !serviceToken)
  throw new Error("LIEGE_API_URL and MCP_INTERNAL_API_TOKEN are required.");
const liegeApiUrl = apiUrl;
const internalToken = serviceToken;
const allowedHosts = ["localhost", "127.0.0.1"];
if (process.env.MCP_PUBLIC_URL) allowedHosts.push(new URL(process.env.MCP_PUBLIC_URL).hostname);
async function api(path: string, connectionToken: string, init: RequestInit = {}) {
  const response = await fetch(`${liegeApiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-mcp-internal-token": internalToken,
      "x-mcp-connection-token": connectionToken,
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "Liege API request failed.");
  return body.data;
}
const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
function serverFor(connectionToken: string) {
  const server = new McpServer({ name: "liege-mcp", version: "0.1.0" });
  server.registerTool(
    "get_agent_profile",
    { description: "Get the Liege agent profile bound to this connection." },
    async () => text(await api("/v1/internal/mcp/session", connectionToken)),
  );
  server.registerTool(
    "list_agent_jobs",
    { description: "List jobs assigned to the connected Liege agent." },
    async () => text(await api("/v1/internal/mcp/jobs", connectionToken)),
  );
  server.registerTool(
    "get_job_details",
    {
      description:
        "Get the private brief and current submission for a job assigned to the connected agent.",
      inputSchema: { jobId: z.string().uuid() },
    },
    async ({ jobId }) => text(await api(`/v1/internal/mcp/jobs/${jobId}`, connectionToken)),
  );
  server.registerTool(
    "propose_action",
    {
      description: "Create a website-only approval proposal; this never executes an action.",
      inputSchema: {
        action: z.enum(["accept_job", "submit_deliverable", "update_agent"]),
        payload: z.record(z.string(), z.unknown()),
      },
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/proposals", connectionToken, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );
  server.registerTool(
    "liege_account_status",
    {
      description:
        "Inspect the connected agent's Liege account status, policy limits, active hours, and remaining spending budget.",
    },
    async () => text(await api("/v1/internal/mcp/account", connectionToken)),
  );
  server.registerTool(
    "liege_account_simulate",
    {
      description:
        "Pre-flight simulate an action against the agent's account spending and authorization policies without executing it.",
      inputSchema: {
        action: z.string().min(1).max(120).describe("The action name to simulate"),
        amount: z.number().nonnegative().optional().describe("Optional transaction amount"),
        asset: z.string().optional().describe("Settlement asset symbol (e.g. usdg, liege)"),
        venue: z.string().optional().describe("Target venue or platform"),
        counterparty: z.string().optional().describe("Target counterparty or wallet address"),
        details: z.record(z.string(), z.unknown()).optional().describe("Arbitrary action parameters and context"),
      },
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/account/simulate", connectionToken, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );
  server.registerTool(
    "liege_account_authorize",
    {
      description:
        "Authorize an action using the agent's Liege account, bound to a prior simulation digest or policy.",
      inputSchema: {
        action: z.string().min(1).max(120).describe("The action name to authorize"),
        amount: z.number().nonnegative().optional().describe("Optional transaction amount"),
        asset: z.string().optional().describe("Settlement asset symbol (e.g. usdg, liege)"),
        venue: z.string().optional().describe("Target venue or platform"),
        counterparty: z.string().optional().describe("Target counterparty or wallet address"),
        details: z.record(z.string(), z.unknown()).optional().describe("Arbitrary action parameters"),
        simulationId: z.string().uuid().optional().describe("Simulation ID from prior liege_account_simulate"),
        simulationDigest: z.string().optional().describe("Simulation digest hash"),
      },
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/account/authorize", connectionToken, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      ),
  );
  server.registerTool(
    "liege_account_mandates",
    {
      description: "Retrieve active owner-signed mandates granted to this agent account.",
    },
    async () => text(await api("/v1/internal/mcp/account/mandates", connectionToken)),
  );
  server.registerTool(
    "list_services",
    {
      description:
        "Browse the Liege Service Catalog to discover available agent tools, data feeds, and skill services.",
    },
    async () => text(await api("/v1/internal/mcp/services", connectionToken)),
  );
  return server;
}
const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });
app.get("/health", (_request, response) =>
  response.json({ status: "ok", service: "liege-mcp", commit: process.env.GIT_SHA || undefined }),
);
app.post("/mcp", async (request, response) => {
  const connectionToken = request.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!connectionToken)
    return response.status(401).json({ error: "Bearer MCP connection token required." });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = serverFor(connectionToken);
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error) {
    if (!response.headersSent)
      response.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
        id: null,
      });
  } finally {
    await transport.close();
    await server.close();
  }
});
app.listen(port, () => console.log(`Liege MCP service listening on :${port}`));
