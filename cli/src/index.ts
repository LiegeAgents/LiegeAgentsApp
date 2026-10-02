#!/usr/bin/env bun

import { createHash } from "node:crypto";

export type Json = Record<string, unknown>;

export const getApiUrl = () =>
  (process.env.LIEGE_API_URL ?? "https://api.liegeagents.com").replace(/\/$/, "");
export const getSessionToken = () => process.env.LIEGE_SESSION_TOKEN;

const BOOLEAN_FLAGS = new Set(["ap2", "help", "h"]);

export function usage(): never {
  console.log(`Liege operator CLI

Usage:
  liege health
  liege agents list
  liege jobs list
  liege runner simulate <agent-id> '<json-workload>'
  liege runner authorize <agent-id> '<json-workload>' --simulation-id <id>
  liege runner execute '<json-workload>' --action-id <id> --simulation-id <id>
  liege runner list [--agent-id <id>]
  liege runner status <run-id>
  liege runner artifact <run-id> <artifact-id>
  liege invoices list
  liege invoices issue '<json-invoice>'
  liege invoices pay <invoice-id>
  liege invoices refund <invoice-id>
  liege invoices cancel <invoice-id>
  liege account list
  liege account status <agent-id>
  liege account pause <agent-id> [--reason <text>]
  liege account resume <agent-id>
  liege account kill <agent-id> [--reason <text>]
  liege account mandates <agent-id> [mandate-id] [--format ap2]
  liege account policy set <agent-id> '<json-policy>'
  liege services list [--agent-id <id>] [--type <tool|data|skill>] [--limit <n>]
  liege services get <agent-id> <slug>
  liege services create '<json-service>' | [flags]
  liege mcp connections
  liege mcp revoke <connection-id>
  liege policy get <agent-id>
  liege policy set <agent-id> '<json-policy>'
  liege proposals list [--status pending|approved|rejected|expired]
  liege proposals get <proposal-id>
  liege proposals wait <proposal-id> [--timeout-ms <n>] [--poll-ms <n>]
  liege proposals approve <proposal-id>
  liege proposals reject <proposal-id>

Environment:
  LIEGE_API_URL       API origin (default: https://api.liegeagents.com)
  LIEGE_SESSION_TOKEN Existing Liege bearer session token
`);
  process.exit(0);
}

export async function request(path: string, init: RequestInit = {}, authenticated = true) {
  const token = getSessionToken();
  if (authenticated && !token) {
    throw new Error("LIEGE_SESSION_TOKEN is required for this command.");
  }
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${getApiUrl()}${path}`, { ...init, headers });
  const body = response.status === 204 ? null : ((await response.json()) as Json);
  if (!response.ok) {
    const details = (body?.error as Json | undefined) ?? {};
    const error = new Error(
      details.message ? String(details.message) : `API request failed (${response.status}).`,
    );
    Object.assign(error, {
      status: response.status,
      code: details.code,
      requestId: response.headers.get("x-request-id") ?? details.requestId,
      retryable: response.status === 429 || response.status >= 500,
    });
    throw error;
  }
  return body?.data ?? body;
}

export function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

export function parseFlags(args: string[]): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = "true";
        } else {
          const next = args[i + 1];
          if (next !== undefined && !next.startsWith("--")) {
            flags[key] = next;
            i++;
          } else {
            flags[key] = "true";
          }
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function jsonArgument(value: string | undefined, label: string): Json {
  if (!value) throw new Error(`${label} must be provided as JSON.`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Json;
  } catch {
    throw new Error(`The ${label} argument must be valid JSON.`);
  }
}

function digest(value: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, string>>((out, key) => {
        out[key] = value[key];
        return out;
      }, {}),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function runnerDetails(input: Json): Json {
  const env = (input.env as Record<string, string> | undefined) ?? {};
  const files = (input.files as Record<string, string> | undefined) ?? {};
  return {
    command: input.command,
    args: input.args ?? [],
    jobId: input.jobId ?? null,
    timeoutMs: input.timeoutMs ?? 30_000,
    maxOutputBytes: input.maxOutputBytes ?? 256_000,
    envDigest: digest(env),
    filesDigest: digest(files),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function execute(args: string[]): Promise<unknown> {
  const { flags, positional } = parseFlags(args);
  const [resource, action, id] = positional;

  if (!resource || resource === "--help" || resource === "-h" || flags.help === "true") usage();

  if (resource === "health") return request("/health", {}, false);
  if (resource === "agents" && action === "list") return request("/v1/agents");
  if (resource === "jobs" && action === "list") return request("/v1/jobs");
  if (resource === "runner" || resource === "runners") {
    if (action === "simulate" && id) {
      const input = jsonArgument(positional[3], "runner workload");
      return request(`/v1/agent-accounts/${encodeURIComponent(id)}/actions/simulate`, {
        method: "POST",
        body: JSON.stringify({ action: "runner.execute", details: runnerDetails(input) }),
      });
    }
    if (action === "authorize" && id) {
      const input = jsonArgument(positional[3], "runner workload");
      const simulationId = flags["simulation-id"] ?? flags.simulationId;
      if (!simulationId) throw new Error("--simulation-id is required for runner authorization.");
      return request(`/v1/agent-accounts/${encodeURIComponent(id)}/actions/authorize`, {
        method: "POST",
        body: JSON.stringify({
          action: "runner.execute",
          details: runnerDetails(input),
          simulationId,
        }),
      });
    }
    if (action === "execute") {
      const input = jsonArgument(id, "runner workload");
      const actionId = flags["action-id"] ?? flags.actionId;
      const simulationId = flags["simulation-id"] ?? flags.simulationId;
      const approval = actionId && simulationId ? { actionId, simulationId } : {};
      return request("/v1/runners", {
        method: "POST",
        body: JSON.stringify({ ...input, ...approval }),
      });
    }
    if (action === "list") {
      const agentId = flags["agent-id"] ?? flags.agentId;
      return request(`/v1/runners${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`);
    }
    if (action === "status" && id) return request(`/v1/runners/${encodeURIComponent(id)}`);
    if (action === "artifact" && id && positional[3])
      return request(
        `/v1/runners/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(positional[3])}`,
      );
  }
  if (resource === "invoices" && action === "list") return request("/v1/invoices");
  if (resource === "invoices" && action === "issue" && positional[2]) {
    let invoice: unknown;
    try {
      invoice = JSON.parse(positional[2]);
    } catch {
      throw new Error("The invoice argument must be valid JSON.");
    }
    return request("/v1/invoices", { method: "POST", body: JSON.stringify(invoice) });
  }
  if (resource === "invoices" && ["pay", "refund", "cancel"].includes(action ?? "") && id)
    return request(`/v1/invoices/${id}/${action}`, { method: "POST" });

  if (resource === "account" || resource === "accounts") {
    if (action === "list") {
      return request("/v1/agent-accounts");
    }
    if ((action === "status" || action === "get") && id) {
      return request(`/v1/agent-accounts/${id}`);
    }
    if (action === "pause" && id) {
      const reason =
        flags.reason ??
        (positional[3] && !positional[3].startsWith("--") ? positional[3] : undefined);
      return request(`/v1/agent-accounts/${id}/control`, {
        method: "POST",
        body: JSON.stringify({ command: "pause", ...(reason ? { reason } : {}) }),
      });
    }
    if (action === "resume" && id) {
      return request(`/v1/agent-accounts/${id}/control`, {
        method: "POST",
        body: JSON.stringify({ command: "resume" }),
      });
    }
    if (action === "kill" && id) {
      const reason =
        flags.reason ??
        (positional[3] && !positional[3].startsWith("--") ? positional[3] : undefined);
      return request(`/v1/agent-accounts/${id}/control`, {
        method: "POST",
        body: JSON.stringify({ command: "kill", ...(reason ? { reason } : {}) }),
      });
    }
    if ((action === "mandates" || action === "mandate") && id) {
      const mandateId =
        positional[3] && !positional[3].startsWith("--") ? positional[3] : undefined;
      const isAp2 = flags.format === "ap2" || flags.ap2 === "true";
      if (mandateId) {
        const path = isAp2
          ? `/v1/agent-accounts/${id}/mandates/${mandateId}/ap2`
          : `/v1/agent-accounts/${id}/mandates/${mandateId}`;
        return request(path);
      }
      return request(`/v1/agent-accounts/${id}/mandates`);
    }
    if (action === "policy") {
      if (id === "set" && positional[3] && positional[4]) {
        const agentId = positional[3];
        let policy: unknown;
        try {
          policy = JSON.parse(positional[4]);
        } catch {
          throw new Error("The policy argument must be valid JSON.");
        }
        return request(`/v1/agent-accounts/${agentId}/policy`, {
          method: "PUT",
          body: JSON.stringify(policy),
        });
      }
      if (id && id !== "set") {
        if (positional[3] === "set" && positional[4]) {
          let policy: unknown;
          try {
            policy = JSON.parse(positional[4]);
          } catch {
            throw new Error("The policy argument must be valid JSON.");
          }
          return request(`/v1/agent-accounts/${id}/policy`, {
            method: "PUT",
            body: JSON.stringify(policy),
          });
        }
        const account = (await request(`/v1/agent-accounts/${id}`)) as Json;
        return account?.policy ?? account;
      }
    }
  }

  if (resource === "services" || resource === "service") {
    if (action === "list") {
      const query = new URLSearchParams();
      const agentId = flags["agent-id"] ?? flags.agentId ?? flags.agent;
      const serviceType = flags["service-type"] ?? flags.serviceType ?? flags.type;
      const limit = flags.limit;
      if (agentId) query.set("agentId", agentId);
      if (serviceType) query.set("type", serviceType);
      if (limit) query.set("limit", limit);
      const queryString = query.toString();
      const path = queryString ? `/v1/services?${queryString}` : "/v1/services";
      return request(path, {}, false);
    }
    if (action === "get" && id && positional[3]) {
      const slug = positional[3];
      return request(`/v1/services/${id}/${slug}`, {}, false);
    }
    if (action === "create") {
      let servicePayload: unknown;
      const rawJson = positional[2];
      if (
        rawJson &&
        (rawJson.startsWith("{") || (!rawJson.startsWith("-") && rawJson.includes(":")))
      ) {
        try {
          servicePayload = JSON.parse(rawJson);
        } catch {
          throw new Error("The service argument must be valid JSON.");
        }
      } else {
        const agentId = flags["agent-id"] ?? flags.agentId ?? flags.agent;
        const slug = flags.slug;
        const name = flags.name;
        const description = flags.description ?? flags.desc;
        const serviceType = flags["service-type"] ?? flags.serviceType ?? flags.type;
        const priceRaw = flags.price ?? flags["price-usd"] ?? flags.priceUsd;
        const slaRaw = flags.sla ?? flags["sla-minutes"] ?? flags.slaMinutes;

        if (!agentId || !slug || !name || !description || !serviceType || !priceRaw || !slaRaw) {
          throw new Error(
            "Missing required service parameters. Provide JSON or flags: --agent-id, --slug, --name, --description, --service-type, --price, --sla",
          );
        }

        let requirementsSchema: Record<string, unknown> = {};
        const reqStr = flags.requirements ?? flags["requirements-schema"];
        if (reqStr) {
          try {
            requirementsSchema = JSON.parse(reqStr);
          } catch {
            throw new Error("Requirements schema must be valid JSON.");
          }
        }

        let deliverableSchema: Record<string, unknown> = {};
        const delStr = flags.deliverables ?? flags["deliverable-schema"];
        if (delStr) {
          try {
            deliverableSchema = JSON.parse(delStr);
          } catch {
            throw new Error("Deliverable schema must be valid JSON.");
          }
        }

        servicePayload = {
          agentId,
          slug,
          name,
          description,
          serviceType,
          executionMode: flags["execution-mode"] ?? flags.executionMode ?? flags.mode ?? "manual",
          priceUsd: Number(priceRaw),
          slaMinutes: Number(slaRaw),
          requirementsSchema,
          deliverableSchema,
        };
      }
      return request("/v1/services", {
        method: "POST",
        body: JSON.stringify(servicePayload),
      });
    }
  }

  if (resource === "mcp" && action === "connections") return request("/v1/mcp/connections");
  if (resource === "mcp" && action === "revoke" && id) {
    await request(`/v1/mcp/connections/${id}`, { method: "DELETE" });
    return { revoked: id };
  }
  if (resource === "policy" && action === "get" && id) return request(`/v1/mcp/policies/${id}`);
  if (resource === "policy" && action === "set" && id && positional[3]) {
    let policy: unknown;
    try {
      policy = JSON.parse(positional[3]);
    } catch {
      throw new Error("The policy argument must be valid JSON.");
    }
    return request(`/v1/mcp/policies/${id}`, { method: "PUT", body: JSON.stringify(policy) });
  }
  if (resource === "proposals" && action === "list") {
    const status = flags.status;
    return request(`/v1/mcp/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }
  if (resource === "proposals" && action === "get" && id)
    return request(`/v1/mcp/proposals/${encodeURIComponent(id)}`);
  if (resource === "proposals" && action === "wait" && id) {
    const timeoutMs = Number(flags["timeout-ms"] ?? flags.timeoutMs ?? 30_000);
    const pollMs = Number(flags["poll-ms"] ?? flags.pollMs ?? 1_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000)
      throw new Error("--timeout-ms must be an integer between 500 and 120000.");
    if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 5_000)
      throw new Error("--poll-ms must be an integer between 250 and 5000.");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const proposal = (await request(`/v1/mcp/proposals/${encodeURIComponent(id)}`)) as Json;
      if (proposal.effective_status !== "pending" || Date.now() >= deadline)
        return { ...proposal, timedOut: proposal.effective_status === "pending" };
      await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }
  if (resource === "proposals" && (action === "approve" || action === "reject") && id)
    return request(`/v1/mcp/proposals/${id}/${action === "approve" ? "approved" : "rejected"}`, {
      method: "POST",
    });

  usage();
}

async function main(args: string[]) {
  const result = await execute(args);
  if (result !== undefined) {
    print(result);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
