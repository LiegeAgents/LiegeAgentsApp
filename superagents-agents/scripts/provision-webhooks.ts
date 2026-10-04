import { readFile, writeFile } from "node:fs/promises";

const apiUrl = (Bun.env.LIEGE_API_URL || "https://api.liegeagents.com").replace(/\/$/, "");
const sessionToken = Bun.env.LIEGE_SESSION_TOKEN?.trim();
const serverUrl = Bun.env.AGENT_SERVER_URL?.trim()?.replace(/\/$/, "");

if (!sessionToken) throw new Error("LIEGE_SESSION_TOKEN is required in superagents-agents/.env");
if (!serverUrl) throw new Error("AGENT_SERVER_URL is required in superagents-agents/.env");

const agents = [
  ["SCOTT", "19ed8fe5-a862-42f2-a912-c730f464f251", "scott"],
  ["ANNA", "597709f8-e5b1-450d-8210-8a9e4b6ced0c", "anna"],
  ["MARCUS", "bfb46bd1-230f-4a62-91b0-53465f9f3636", "marcus"],
  ["CHLOE", "0c023086-c215-47ca-8207-858fac7b99f9", "chloe"],
  ["DANIEL", "d3ba1dbd-321b-4edf-accc-ee4a9405e4f0", "daniel"],
] as const;
const eventTypes = ["job.funded", "job.submitted", "job.expired", "job.settled"];
const headers = { authorization: `Bearer ${sessionToken}`, accept: "application/json" };

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} failed (${response.status}): ${body?.error?.message || "request failed"}`);
  return body?.data ?? body;
}

const subscriptions = await api("/v1/webhooks");
const values: Record<string, string> = {};
for (const [label, agentId, slug] of agents) {
  for (const subscription of subscriptions as Array<{ id: string; agent_id: string; url: string }>) {
    if (subscription.agent_id === agentId && subscription.url === `${serverUrl}/webhooks/${slug}`) {
      await api(`/v1/webhooks/${subscription.id}`, { method: "DELETE" });
    }
  }
  const created = await api("/v1/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId,
      url: `${serverUrl}/webhooks/${slug}`,
      eventTypes,
    }),
  });
  if (!created?.secret) throw new Error(`No secret returned for ${label}.`);
  values[`${label}_AGENT_ID`] = agentId;
  values[`${label}_WEBHOOK_SECRET`] = created.secret;
  console.log(`${label}: provisioned subscription ${created.id}`);
}

const envPath = ".env";
const source = await readFile(envPath, "utf8");
const lines = source.split(/\r?\n/);
for (const [key, value] of Object.entries(values)) {
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const line = `${key}=${value}`;
  if (index === -1) lines.push(line);
  else lines[index] = line;
}
await writeFile(envPath, `${lines.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
console.log(`Updated ${envPath} with canonical agent IDs and fresh webhook secrets.`);
