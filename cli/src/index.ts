#!/usr/bin/env bun

type Json = Record<string, unknown>;

const apiUrl = (process.env.LIEGE_API_URL ?? "https://api.liegeagents.com").replace(/\/$/, "");
const sessionToken = process.env.LIEGE_SESSION_TOKEN;

function usage(): never {
  console.log(`Liege operator CLI

Usage:
  liege health
  liege agents list
  liege jobs list
  liege invoices list
  liege invoices issue '<json-invoice>'
  liege invoices pay <invoice-id>
  liege invoices refund <invoice-id>
  liege invoices cancel <invoice-id>
  liege mcp connections
  liege mcp revoke <connection-id>
  liege policy get <agent-id>
  liege policy set <agent-id> '<json-policy>'
  liege proposals list
  liege proposals approve <proposal-id>
  liege proposals reject <proposal-id>

Environment:
  LIEGE_API_URL       API origin (default: https://api.liegeagents.com)
  LIEGE_SESSION_TOKEN Existing Liege bearer session token
`);
  process.exit(0);
}

async function request(path: string, init: RequestInit = {}, authenticated = true) {
  if (authenticated && !sessionToken) {
    throw new Error("LIEGE_SESSION_TOKEN is required for this command.");
  }
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (authenticated) headers.set("authorization", `Bearer ${sessionToken}`);
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  const body = response.status === 204 ? null : ((await response.json()) as Json);
  if (!response.ok) {
    const error = (body?.error as Json | undefined)?.message;
    throw new Error(error ? String(error) : `API request failed (${response.status}).`);
  }
  return body?.data ?? body;
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

async function main(args: string[]) {
  const [resource, action, id] = args;
  if (!resource || resource === "--help" || resource === "-h") usage();
  if (resource === "health") return print(await request("/health", {}, false));
  if (resource === "agents" && action === "list") return print(await request("/v1/agents"));
  if (resource === "jobs" && action === "list") return print(await request("/v1/jobs"));
  if (resource === "invoices" && action === "list") return print(await request("/v1/invoices"));
  if (resource === "invoices" && action === "issue" && args[2]) {
    let invoice: unknown;
    try {
      invoice = JSON.parse(args[2]);
    } catch {
      throw new Error("The invoice argument must be valid JSON.");
    }
    return print(await request("/v1/invoices", { method: "POST", body: JSON.stringify(invoice) }));
  }
  if (resource === "invoices" && ["pay", "refund", "cancel"].includes(action ?? "") && id)
    return print(await request(`/v1/invoices/${id}/${action}`, { method: "POST" }));
  if (resource === "mcp" && action === "connections")
    return print(await request("/v1/mcp/connections"));
  if (resource === "mcp" && action === "revoke" && id) {
    await request(`/v1/mcp/connections/${id}`, { method: "DELETE" });
    return print({ revoked: id });
  }
  if (resource === "policy" && action === "get" && id)
    return print(await request(`/v1/mcp/policies/${id}`));
  if (resource === "policy" && action === "set" && id && args[3]) {
    let policy: unknown;
    try {
      policy = JSON.parse(args[3]);
    } catch {
      throw new Error("The policy argument must be valid JSON.");
    }
    return print(
      await request(`/v1/mcp/policies/${id}`, { method: "PUT", body: JSON.stringify(policy) }),
    );
  }
  if (resource === "proposals" && action === "list")
    return print(await request("/v1/mcp/proposals"));
  if (resource === "proposals" && (action === "approve" || action === "reject") && id)
    return print(
      await request(`/v1/mcp/proposals/${id}/${action === "approve" ? "approved" : "rejected"}`, {
        method: "POST",
      }),
    );
  usage();
}

main(Bun.argv.slice(2)).catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
