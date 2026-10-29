import { randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { env } from "../config.js";
import { ApiError, asyncRoute } from "../http.js";
import { createIntent } from "./superAgents.js";
import {
  hireKeyForToken,
  hireOutcome,
  hireableAgents,
  pendingNote,
  withinCaps,
} from "./hireKeys.js";

// A2A (protocol 0.3.0) for Liege Super Agents. Cards are public; calls authenticate with a
// hiring key, so a message creates a proposal the key owner approves and funds in Liege, and
// the task reports that proposal, its job, and the delivered work. Nothing here moves money.

const PROTOCOL_VERSION = "0.3.0";
const base = () => env.PUBLIC_API_URL.replace(/\/+$/, "");
const security = {
  securitySchemes: {
    hiringKey: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "Liege hiring key (lmh_)",
      description:
        "Create a hiring key in Liege Super Agents → Hiring keys. Messages become proposals the key owner approves and funds; the key's per-hire and daily USDG limits apply.",
    },
  },
  security: [{ hiringKey: [] }],
};
const commonCard = {
  protocolVersion: PROTOCOL_VERSION,
  preferredTransport: "JSONRPC",
  version: "1.0.0",
  provider: { organization: "Liege", url: "https://liegeagents.com" },
  documentationUrl: "https://superagents.liegeagents.com/app?view=hire-keys",
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/markdown"],
  ...security,
};
type Hireable = Awaited<ReturnType<typeof hireableAgents>>[number];
// Service descriptions are free text; join them into one line that ends as a sentence.
const sentence = (text: string | null) => {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return !line || /[.!?]$/.test(line) ? line : `${line}.`;
};
const skillFor = (agent: Hireable) => ({
  id: agent.slug,
  name: `${agent.name}: ${agent.service_name}`,
  description: `${sentence(agent.description)} Listed at ${Number(agent.price_usd)} USD, delivered within ${agent.sla_minutes} minutes.`,
  // A2A examples are sample prompts; the owner's example request is exactly that.
  ...(agent.sample_request ? { examples: [agent.sample_request] } : {}),
  tags: [agent.category, "liege", "super-agent", ...(agent.verified ? ["verified"] : [])].filter(
    Boolean,
  ),
});

export const wellKnownRouter = Router();
wellKnownRouter.get(
  "/agent-card.json",
  asyncRoute(async (_request, response) => {
    const agents = await hireableAgents();
    response.set("cache-control", "public, max-age=300").json({
      name: "Liege Super Agents",
      description:
        "Hire verified Liege Super Agents. Name the agent in your message, e.g. 'Hire Scott to summarize this week's Robinhood Chain news'. Each message becomes a proposal the hiring key's owner approves and funds; the task completes with the delivered work.",
      url: `${base()}/v1/a2a`,
      ...commonCard,
      skills: agents.map(skillFor),
    });
  }),
);

export const a2aRouter = Router();
a2aRouter.get(
  "/:slug/agent-card.json",
  asyncRoute(async (request, response) => {
    const slug = z.string().min(1).max(80).parse(request.params.slug);
    const [agent] = await hireableAgents(slug);
    if (!agent) throw new ApiError(404, "agent_not_found", "This agent cannot be hired over A2A.");
    response.set("cache-control", "public, max-age=300").json({
      name: agent.name,
      description: `${sentence(agent.description)} Each message becomes a proposal the hiring key's owner approves and funds in Liege; the task completes with the delivered work.`,
      url: `${base()}/v1/a2a/${agent.slug}`,
      ...commonCard,
      skills: [skillFor(agent)],
    });
  }),
);

const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const sendParams = z.object({
  message: z.object({
    role: z.literal("user"),
    parts: z.array(z.object({ kind: z.string(), text: z.string().optional() }).passthrough()),
    messageId: z.string().min(1).max(200),
    taskId: z.string().optional(),
    contextId: z.string().optional(),
  }),
  // A USDG budget; without one the proposal uses the agent's listed price.
  metadata: z.object({ budgetAmount: z.number().finite().positive().optional() }).optional(),
});
const taskParams = z.object({ id: z.string().uuid() });

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const agentMessage = (taskId: string, text: string) => ({
  kind: "message",
  role: "agent",
  messageId: randomUUID(),
  taskId,
  contextId: taskId,
  parts: [{ kind: "text", text }],
});

/** Reports a proposal as an A2A task: the owner's decision, the job, then the delivery. */
async function taskFor(
  key: Awaited<ReturnType<typeof hireKeyForToken>>,
  id: string,
  requestId?: string,
) {
  const outcome = await hireOutcome(key, id, requestId);
  const [state, text] = ((): [string, string] => {
    if (outcome.proposalStatus === "pending") return ["submitted", pendingNote];
    if (outcome.proposalStatus === "expired")
      return ["canceled", "The proposal expired before it was approved."];
    if (outcome.proposalStatus === "rejected")
      return ["rejected", "The key owner dismissed this proposal."];
    switch (outcome.jobStatus) {
      case "open":
        return ["submitted", "Approved. Waiting for the key owner to fund the job."];
      case "funded":
        return ["working", outcome.progress?.message ?? "The agent is working on it."];
      case "submitted":
        return ["completed", "Delivered. The key owner reviews it before payment is released."];
      case "completed":
        return ["completed", "Delivered and accepted."];
      case "challenged":
        return ["completed", "Delivered. The key owner disputed the delivery."];
      case "rejected":
        return ["failed", "The key owner rejected the delivery."];
      case "cancelled":
        return ["canceled", "The job was cancelled."];
      default:
        return ["failed", "The job expired without a delivery."];
    }
  })();
  return {
    kind: "task",
    id,
    contextId: id,
    status: { state, message: agentMessage(id, text), timestamp: new Date().toISOString() },
    ...(outcome.deliverable
      ? {
          artifacts: [
            {
              artifactId: `${id}:deliverable`,
              name: "Deliverable",
              parts: [{ kind: "text", text: outcome.deliverable }],
              metadata: { jobId: outcome.jobId, deliverableHash: outcome.deliverableHash },
            },
          ],
        }
      : {}),
    metadata: {
      proposalStatus: outcome.proposalStatus,
      jobId: outcome.jobId,
      jobStatus: outcome.jobStatus,
    },
  };
}

async function handle(
  slug: string | undefined,
  authorization: string | undefined,
  body: unknown,
  requestId: string | undefined,
  response: Response,
) {
  const parsed = rpcRequest.safeParse(body);
  const id = parsed.success ? (parsed.data.id ?? null) : null;
  const reply = (result: unknown) => response.json({ jsonrpc: "2.0", id, result });
  try {
    if (!parsed.success) throw new RpcError(-32600, "Invalid JSON-RPC request.");
    const { method, params } = parsed.data;
    if (method !== "message/send" && method !== "tasks/get")
      throw new RpcError(-32601, `Method ${method} is not supported.`);
    const key = await hireKeyForToken(authorization?.match(/^Bearer (.+)$/i)?.[1]);
    if (method === "tasks/get") {
      const query = taskParams.safeParse(params);
      if (!query.success) throw new RpcError(-32602, "Provide the task id.");
      return reply(await taskFor(key, query.data.id, requestId));
    }
    const send = sendParams.safeParse(params);
    if (!send.success) throw new RpcError(-32602, "Provide a user message with text parts.");
    const { message, metadata } = send.data;
    if (message.taskId)
      // A task follows its proposal; read it with tasks/get, or send a new message for new work.
      throw new RpcError(-32004, "Replies to an existing task are not supported.");
    const text = message.parts
      .filter((part) => part.kind === "text" && part.text)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text || text.length > 10_000)
      throw new RpcError(-32602, "Send the request as text, up to 10,000 characters.");
    let agentName: string | undefined;
    if (slug) {
      const [agent] = await hireableAgents(slug);
      if (!agent) throw new RpcError(-32602, "This agent cannot be hired over A2A.");
      agentName = agent.name;
    }
    const intent = await createIntent(key.user_id, requestId, {
      text,
      source: "mcp",
      agentName,
      budgetAmount: metadata?.budgetAmount,
      suggestBudget: true,
      hireKeyId: key.id,
      cap: (budget, asset) => withinCaps(key, budget, asset),
    });
    return reply(await taskFor(key, intent.id, requestId));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
    const rpc =
      error instanceof RpcError
        ? error
        : error instanceof ApiError && error.status === 404
          ? new RpcError(-32001, "Task not found.")
          : error instanceof ApiError && error.status < 500
            ? new RpcError(-32602, error.message, { code: error.code })
            : null;
    if (!rpc) throw error;
    response.json({
      jsonrpc: "2.0",
      id,
      error: { code: rpc.code, message: rpc.message, ...(rpc.data ? { data: rpc.data } : {}) },
    });
  }
}

a2aRouter.post(
  "/",
  asyncRoute((request, response) =>
    handle(undefined, request.header("authorization"), request.body, request.requestId, response),
  ),
);
a2aRouter.post(
  "/:slug",
  asyncRoute((request, response) =>
    handle(
      z.string().min(1).max(80).parse(request.params.slug),
      request.header("authorization"),
      request.body,
      request.requestId,
      response,
    ),
  ),
);
