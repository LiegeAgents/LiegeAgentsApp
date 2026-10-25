import express from "express";
import { z } from "zod";
import { issueNonce, createSession, revokeSession } from "./auth.js";
import { env } from "./config.js";
import { agentsRouter } from "./routes/agents.js";
import { jobsRouter } from "./routes/jobs.js";
import { cronRouter } from "./routes/cron.js";
import { evaluatorsRouter } from "./routes/evaluators.js";
import { adminRouter } from "./routes/admin.js";
import { adminAccessRouter } from "./routes/adminAccess.js";
import { accountRouter } from "./routes/account.js";
import { mcpInternalRouter, mcpRouter } from "./routes/mcp.js";
import { hireKeysRouter, hireRouter } from "./routes/hireKeys.js";
import { a2aRouter, wellKnownRouter } from "./routes/a2a.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { runnersRouter } from "./routes/runners.js";
import { evaluationRouter } from "./routes/evaluation.js";
import { invoicesRouter } from "./routes/invoices.js";
import { agentAccountsRouter } from "./routes/agentAccounts.js";
import { receiptsRouter } from "./routes/receipts.js";
import { receiptAnchorsRouter } from "./routes/jobReceipts.js";
import { servicesRouter } from "./routes/services.js";
import { x402CallsRouter } from "./routes/x402Calls.js";
import { disputesRouter } from "./routes/disputes.js";
import { legionsRouter } from "./routes/legions.js";
import { ApiError, asyncRoute, errorHandler } from "./http.js";
import { parseTrustProxy, rateLimit, requestContext } from "./operations.js";
import { getAcpStatus } from "./acp.js";
import { mobileRouter } from "./routes/mobile.js";
import { superAgentsRouter, xCallback } from "./routes/superAgents.js";
import { githubHooksRouter } from "./routes/githubTriggers.js";
import { runtimeRouter } from "./routes/runtime.js";
import { stakingRouter } from "./routes/staking.js";
import { notificationsRouter } from "./routes/notifications.js";
import { platformStatus } from "./status.js";
import { leaderboard } from "./leaderboard.js";

export const app = express();
export const healthPayload = () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
  version: process.env.npm_package_version ?? "0.1.0",
  // Set in the container image; lets a deployment confirm which commit is serving.
  commit: process.env.GIT_SHA || undefined,
});
const cliInstaller = await Bun.file(new URL("../install.sh", import.meta.url)).text();
const liegeSkill = await Bun.file(new URL("../skill.md", import.meta.url)).text();
app.disable("x-powered-by");
app.set("trust proxy", parseTrustProxy(env.TRUST_PROXY));
// Before body parsing, so even a malformed-body error carries a request id.
app.use(requestContext);
const jsonBody = express.json({ limit: "128kb" });
// GitHub webhooks are verified against their exact bytes, so they skip JSON parsing.
app.use((request, response, next) =>
  request.path.startsWith("/v1/github/hooks/") ? next() : jsonBody(request, response, next),
);
app.use(rateLimit);
app.get("/health", (_request, response) => response.json(healthPayload()));
app.get("/install.sh", (_request, response) => {
  response.type("application/x-sh").set("cache-control", "no-store").send(cliInstaller);
});
app.get("/skill.md", (_request, response) => {
  response.type("text/markdown").set("cache-control", "public, max-age=300").send(liegeSkill);
});
app.get("/health/config", (_request, response) =>
  response.json({
    chainId: env.RHC_ID,
    escrowMode: env.ESCROW_MODE,
    jobEscrowRouting:
      env.ESCROW_MODE === "ledger"
        ? { withEvaluator: "ledger", withoutEvaluator: "ledger" }
        : { withEvaluator: "veilora", withoutEvaluator: "onchain" },
    usdgTokenAddress: env.USDG_TOKEN_ADDRESS ?? null,
  }),
);
app.get("/health/acp", (_request, response) => response.json(getAcpStatus()));
// Public: agents ranked by their recorded track record, each with its latest anchored snapshot.
app.get("/v1/leaderboard", async (_request, response, next) => {
  try {
    response.set("cache-control", "public, max-age=30").json({ data: await leaderboard() });
  } catch (error) {
    next(error);
  }
});
// Public: whether the API answers and which verified Super Agents their runtimes report as loaded.
app.get("/v1/status", async (_request, response, next) => {
  try {
    response
      .set("cache-control", "public, max-age=30")
      .json({ data: await platformStatus(process.env.GIT_SHA || undefined) });
  } catch (error) {
    next(error);
  }
});
app.get(
  "/health/ready",
  asyncRoute(async (_request, response) => {
    await (await import("./db/index.js")).db.query("SELECT 1");
    response.json({ status: "ready", timestamp: new Date().toISOString() });
  }),
);
app.post(
  "/v1/auth/nonce",
  asyncRoute(async (request, response) => {
    const { address } = z
      .object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })
      .parse(request.body);
    response.status(201).json({ data: await issueNonce(address) });
  }),
);
app.post(
  "/v1/auth/verify",
  asyncRoute(async (request, response) => {
    const { address, nonce, signature } = z
      .object({
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        nonce: z.string().min(1),
        signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      })
      .parse(request.body);
    response.json({ data: await createSession(address, nonce, signature as `0x${string}`) });
  }),
);
app.post("/v1/auth/logout", revokeSession);
// Password-authenticated metrics are separate from wallet-admin mutations.
app.use("/v1/admin", adminAccessRouter);
// Keep the callback path already configured in deployed X applications.
app.get("/api/v1/auth/x/callback", xCallback);
// Exported so the API contract test can list every route.
export const routers = [
  ["/v1", accountRouter],
  ["/v1/notifications", notificationsRouter],
  ["/v1/agents", agentsRouter],
  ["/v1/jobs", jobsRouter],
  ["/v1/jobs", legionsRouter],
  ["/v1/evaluators", evaluatorsRouter],
  ["/v1/admin", adminRouter],
  ["/v1/cron", cronRouter],
  ["/v1/webhooks", webhooksRouter],
  ["/v1/runners", runnersRouter],
  ["/v1/evaluations", evaluationRouter],
  ["/v1/invoices", invoicesRouter],
  ["/v1/agent-accounts", agentAccountsRouter],
  ["/v1/receipt-anchors", receiptAnchorsRouter],
  ["/v1/receipts", receiptsRouter],
  ["/v1/services", servicesRouter],
  ["/v1/mobile", mobileRouter],
  ["/v1/super-agents", superAgentsRouter],
  ["/v1/staking", stakingRouter],
  ["/v1/github", githubHooksRouter],
  ["/v1/x402", x402CallsRouter],
  ["/v1/disputes", disputesRouter],
  ["/v1/a2a", a2aRouter],
  ["/.well-known", wellKnownRouter],
] as const;
for (const [path, router] of routers) app.use(path, router);
// MCP's internal service routes are intentionally outside the public OpenAPI contract.
app.use("/v1/mcp/hire-keys", hireKeysRouter);
app.use("/v1/mcp", mcpRouter);
app.use("/v1/internal/mcp/hire", hireRouter);
app.use("/v1/internal/mcp", mcpInternalRouter);
app.use("/v1/internal/runtime", runtimeRouter);
app.use((_request, _response, next) => next(new ApiError(404, "not_found", "Route not found.")));
app.use(errorHandler);
