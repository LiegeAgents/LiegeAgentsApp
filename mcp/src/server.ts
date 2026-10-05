import { createHash } from "node:crypto";
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
class McpUpstreamError extends Error {
  constructor(
    public readonly details: {
      code: string;
      status: number;
      requestId?: string;
      retryable: boolean;
      message: string;
    },
  ) {
    super(details.message);
  }
}
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
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body.error ?? {};
    throw new McpUpstreamError({
      code: error.code ?? "upstream_error",
      status: response.status,
      requestId: error.requestId ?? response.headers.get("x-request-id") ?? undefined,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      message: error.message ?? "Liege API request failed.",
    });
  }
  if (body.nextCursor !== undefined)
    return {
      items: body.data ?? [],
      nextCursor: body.nextCursor,
      ...(body.policy ? { policy: body.policy } : {}),
    };
  return body.data;
}
const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const runnerInput = {
  command: z.enum(["node", "bun", "python", "python3"]),
  args: z.array(z.string()).max(40).optional(),
  env: z.record(z.string(), z.string()).optional(),
  files: z.record(z.string(), z.string()).optional(),
  artifactPaths: z.array(z.string()).max(20).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  maxOutputBytes: z.number().int().min(1_024).max(1_000_000).optional(),
  jobId: z.string().uuid().optional(),
};
const digest = (value: Record<string, string>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(value)
          .sort()
          .reduce((out, key) => ({ ...out, [key]: value[key] }), {}),
      ),
    )
    .digest("hex");
const runnerDetails = (input: Record<string, any>) => ({
  command: input.command,
  args: input.args ?? [],
  jobId: input.jobId ?? null,
  timeoutMs: input.timeoutMs ?? 30_000,
  maxOutputBytes: input.maxOutputBytes ?? 256_000,
  envDigest: digest(input.env ?? {}),
  filesDigest: digest(input.files ?? {}),
});
const jobSubmissionInput = {
  jobId: z.string().uuid(),
  deliverable: z.string().min(1).max(100_000),
  evidence: z.array(z.string().url()).max(20).optional(),
};
const jobEvaluationInput = {
  jobId: z.string().uuid(),
  outcome: z.enum(["accepted", "rejected"]),
  rationale: z.string().min(1).max(100_000),
};
function serverFor(connectionToken: string) {
  const server = new McpServer({ name: "liege-mcp", version: "0.1.1" });
  server.registerTool(
    "get_agent_profile",
    { description: "Get the Liege agent profile bound to this connection." },
    async () => text(await api("/v1/internal/mcp/session", connectionToken)),
  );
  server.registerTool(
    "super_agent_enrollment_status",
    {
      description:
        "Inspect whether the connected Liege agent is configured, verified, and discoverable as a Super Agent. Read-only.",
    },
    async () => text(await api("/v1/internal/mcp/super-agent/enrollment", connectionToken)),
  );
  server.registerTool(
    "list_job_events",
    {
      description:
        "Read durable lifecycle events for the connected agent. Persist nextCursor only after processing the returned events, then pass it as after on the next call.",
      inputSchema: {
        after: z.string().regex(/^\d+$/).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ after, limit }) =>
      text(
        await api(
          `/v1/internal/mcp/events?${new URLSearchParams({ ...(after ? { after } : {}), ...(limit ? { limit: String(limit) } : {}) })}`,
          connectionToken,
        ),
      ),
  );
  server.registerTool(
    "wait_for_job_event",
    {
      description:
        "Wait for the next durable lifecycle event after a cursor. This is bounded and never changes job state; persist the returned cursor after processing.",
      inputSchema: {
        after: z.string().regex(/^\d+$/),
        timeoutMs: z.number().int().min(500).max(120_000).optional(),
        pollMs: z.number().int().min(500).max(10_000).optional(),
      },
    },
    async ({ after, timeoutMs = 30_000, pollMs = 2_000 }) => {
      const deadline = Date.now() + timeoutMs;
      let cursor = after;
      for (;;) {
        const result = (await api(
          `/v1/internal/mcp/events?${new URLSearchParams({ after: cursor, limit: "1" })}`,
          connectionToken,
        )) as { items?: Array<Record<string, unknown>>; nextCursor?: string | null };
        const event = result.items?.[0];
        if (event) return text({ event, timedOut: false });
        const remaining = deadline - Date.now();
        if (remaining <= 0) return text({ event: null, cursor, timedOut: true });
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
      }
    },
  );
  server.registerTool(
    "list_agent_jobs",
    {
      description:
        "List jobs assigned to the connected Liege agent. Use nextCursor to fetch the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        settlementAsset: z.enum(["usdg", "liege"]).optional(),
      },
    },
    async ({ limit, cursor }) =>
      text(
        await api(
          `/v1/internal/mcp/jobs?${new URLSearchParams({ ...(limit ? { limit: String(limit) } : {}), ...(cursor ? { cursor } : {}) })}`,
          connectionToken,
        ),
      ),
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
    "simulate_job_submission",
    {
      description:
        "Pre-flight simulate a deliverable submission against the connected agent policy. This never changes the job.",
      inputSchema: jobSubmissionInput,
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/account/simulate", connectionToken, {
          method: "POST",
          body: JSON.stringify({
            action: "submit_deliverable",
            details: { ...input, evidence: input.evidence ?? [] },
          }),
        }),
      ),
  );
  server.registerTool(
    "propose_deliverable_submission",
    {
      description:
        "Create a human approval proposal to submit a deliverable for an assigned funded job. This never mutates the job directly.",
      inputSchema: { ...jobSubmissionInput, simulationId: z.string().uuid() },
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/proposals", connectionToken, {
          method: "POST",
          body: JSON.stringify({
            action: "submit_deliverable",
            payload: {
              jobId: input.jobId,
              deliverable: input.deliverable,
              evidence: input.evidence ?? [],
            },
            simulationId: input.simulationId,
          }),
        }),
      ),
  );
  server.registerTool(
    "simulate_job_evaluation",
    {
      description:
        "Pre-flight simulate an evaluation decision for an assigned submitted job. This never settles or changes the job.",
      inputSchema: jobEvaluationInput,
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/account/simulate", connectionToken, {
          method: "POST",
          body: JSON.stringify({ action: "evaluate_job", details: input }),
        }),
      ),
  );
  server.registerTool(
    "propose_job_evaluation",
    {
      description:
        "Create a human approval proposal for an evaluation decision. Approval records intent only; settlement remains the API job-evaluation flow.",
      inputSchema: { ...jobEvaluationInput, simulationId: z.string().uuid() },
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/proposals", connectionToken, {
          method: "POST",
          body: JSON.stringify({
            action: "evaluate_job",
            payload: {
              jobId: input.jobId,
              outcome: input.outcome,
              rationale: input.rationale,
            },
            simulationId: input.simulationId,
          }),
        }),
      ),
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
    "list_proposals",
    {
      description:
        "List approval proposals for the connected agent, including expired and decided proposals.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        status: z.enum(["all", "pending", "approved", "rejected", "expired"]).optional(),
      },
    },
    async ({ limit, status }) =>
      text(
        await api(
          `/v1/internal/mcp/proposals?${new URLSearchParams({ ...(limit ? { limit: String(limit) } : {}), ...(status ? { status } : {}) })}`,
          connectionToken,
        ),
      ),
  );
  server.registerTool(
    "get_proposal",
    {
      description:
        "Inspect one approval proposal and its current lifecycle status for the connected agent.",
      inputSchema: { proposalId: z.string().uuid() },
    },
    async ({ proposalId }) =>
      text(await api(`/v1/internal/mcp/proposals/${proposalId}`, connectionToken)),
  );
  server.registerTool(
    "get_execution_grant",
    {
      description:
        "Retrieve the one-time execution grant for an approved deliverable proposal. The grant is bound to one job and expires shortly after the proposal.",
      inputSchema: { proposalId: z.string().uuid() },
    },
    async ({ proposalId }) =>
      text(await api(`/v1/internal/mcp/proposals/${proposalId}/grant`, connectionToken)),
  );
  server.registerTool(
    "submit_granted_deliverable",
    {
      description:
        "Submit one deliverable using a one-time execution grant returned by get_execution_grant. This cannot fund, sign, settle, or submit a second time.",
      inputSchema: {
        grantToken: z.string().regex(/^lxe_[A-Za-z0-9_-]+$/),
        jobId: z.string().uuid(),
        deliverable: z.string().min(1).max(100_000),
        evidence: z.array(z.string().url()).max(20).optional(),
      },
    },
    async ({ grantToken, jobId, deliverable, evidence }) =>
      text(
        await api("/v1/internal/mcp/execution-grants/submit", connectionToken, {
          method: "POST",
          headers: { "x-liege-execution-grant": grantToken },
          body: JSON.stringify({ jobId, deliverable, evidence: evidence ?? [] }),
        }),
      ),
  );
  server.registerTool(
    "wait_for_proposal_decision",
    {
      description:
        "Wait for a bounded period until a proposal is approved, rejected, or expired. This never approves a proposal.",
      inputSchema: {
        proposalId: z.string().uuid(),
        timeoutMs: z.number().int().min(500).max(120_000).optional(),
        pollMs: z.number().int().min(250).max(5_000).optional(),
      },
    },
    async ({ proposalId, timeoutMs = 30_000, pollMs = 1_000 }) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const proposal = (await api(
          `/v1/internal/mcp/proposals/${proposalId}`,
          connectionToken,
        )) as Record<string, unknown>;
        if (proposal.effective_status !== "pending" || Date.now() >= deadline)
          return text({ ...proposal, timedOut: proposal.effective_status === "pending" });
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))),
        );
      }
    },
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
        details: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arbitrary action parameters and context"),
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
        details: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arbitrary action parameters"),
        simulationId: z
          .string()
          .uuid()
          .optional()
          .describe("Simulation ID from prior liege_account_simulate"),
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
    "runner_simulate",
    {
      description:
        "Simulate a bounded runner workload against the connected agent policy. This never executes code.",
      inputSchema: runnerInput,
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/account/simulate", connectionToken, {
          method: "POST",
          body: JSON.stringify({ action: "runner.execute", details: runnerDetails(input) }),
        }),
      ),
  );
  server.registerTool(
    "runner_authorize",
    {
      description:
        "Authorize a simulated runner workload. This creates an approval decision but does not execute code.",
      inputSchema: { ...runnerInput, simulationId: z.string().uuid() },
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/account/authorize", connectionToken, {
          method: "POST",
          body: JSON.stringify({
            action: "runner.execute",
            details: runnerDetails(input),
            simulationId: input.simulationId,
          }),
        }),
      ),
  );
  server.registerTool(
    "runner_propose_execution",
    {
      description:
        "Create a website approval proposal for an authorized runner workload. Direct MCP execution is intentionally unavailable.",
      inputSchema: { ...runnerInput, simulationId: z.string().uuid() },
    },
    async (input) =>
      text(
        await api("/v1/internal/mcp/proposals", connectionToken, {
          method: "POST",
          body: JSON.stringify({
            action: "runner.execute",
            payload: runnerDetails(input),
            simulationId: input.simulationId,
          }),
        }),
      ),
  );
  server.registerTool(
    "runner_health",
    {
      description:
        "Check whether the Liege runner worker is configured and reachable. Read-only; no workload is started.",
    },
    async () => text(await api("/v1/internal/mcp/runner/health", connectionToken)),
  );
  server.registerTool(
    "runner_status",
    {
      description:
        "Read status and artifact metadata for a runner execution owned by this connection's agent.",
      inputSchema: { runId: z.string().uuid() },
    },
    async ({ runId }) => text(await api(`/v1/internal/mcp/runner/${runId}`, connectionToken)),
  );
  server.registerTool(
    "runner_artifact",
    {
      description: "Read an encrypted artifact captured by an owned runner execution.",
      inputSchema: { runId: z.string().uuid(), artifactId: z.string().uuid() },
    },
    async ({ runId, artifactId }) =>
      text(await api(`/v1/internal/mcp/runner/${runId}/artifacts/${artifactId}`, connectionToken)),
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
      description: "Browse the Liege Service Catalog. Use nextCursor to fetch the next page.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        settlementAsset: z.enum(["usdg", "liege"]).optional(),
      },
    },
    async ({ limit, cursor, settlementAsset }) =>
      text(
        await api(
          `/v1/internal/mcp/services?${new URLSearchParams({ ...(limit ? { limit: String(limit) } : {}), ...(cursor ? { cursor } : {}), ...(settlementAsset ? { settlementAsset } : {}) })}`,
          connectionToken,
        ),
      ),
  );
  server.registerTool(
    "get_agent_reputation",
    {
      description:
        "Fetch the public, digest-backed reputation and SLA audit for an agent before proposing work.",
      inputSchema: {
        slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      },
    },
    async ({ slug }) =>
      text(await api(`/v1/agents/${encodeURIComponent(slug)}/reputation`, connectionToken)),
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
    if (!response.headersSent) {
      const details =
        error instanceof McpUpstreamError
          ? error.details
          : {
              code: "internal_error",
              status: 500,
              retryable: false,
              message: error instanceof Error ? error.message : "Internal error",
            };
      response.status(200).json({
        jsonrpc: "2.0",
        error: {
          code: details.status === 400 ? -32602 : -32000,
          message: details.message,
          data: {
            code: details.code,
            status: details.status,
            requestId: details.requestId,
            retryable: details.retryable,
          },
        },
        id: null,
      });
    }
  } finally {
    await transport.close();
    await server.close();
  }
});
app.listen(port, () => console.log(`Liege MCP service listening on :${port}`));
