import type { AgentKey } from "./types.js";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const coreAgents: AgentKey[] = ["scott", "anna", "marcus", "chloe", "daniel"];
// Optional agents are served only once both their agent ID and webhook secret are deployed.
const optionalAgents: AgentKey[] = ["kori"];

function configured(key: AgentKey) {
  const id = Boolean(process.env[`${key.toUpperCase()}_AGENT_ID`]?.trim());
  const secret = Boolean(process.env[`${key.toUpperCase()}_WEBHOOK_SECRET`]?.trim());
  if (id !== secret)
    throw new Error(`${key.toUpperCase()}_AGENT_ID and ${key.toUpperCase()}_WEBHOOK_SECRET must be set together.`);
  return id;
}

export const config = {
  apiUrl: required("LIEGE_API_URL").replace(/\/$/, ""),
  runtimeToken: required("LIEGE_RUNTIME_TOKEN"),
  serverUrl: process.env.AGENT_SERVER_URL?.trim()?.replace(/\/$/, "") ?? "",
  port: Number(process.env.PORT ?? 3210),
  groqKey: required("GROQ_API_KEY"),
  groqModel: process.env.GROQ_MODEL?.trim() || "qwen/qwen3.8-27b",
  groqTimeoutMs: Number(process.env.GROQ_TIMEOUT_MS ?? 30_000),
  groqMaxTokens: Number(process.env.GROQ_MAX_TOKENS ?? 4_000),
  agents: Object.fromEntries(
    [...coreAgents, ...optionalAgents.filter(configured)].map((key) => [
      key,
      {
        key,
        id: required(`${key.toUpperCase()}_AGENT_ID`),
        secret: required(`${key.toUpperCase()}_WEBHOOK_SECRET`),
      },
    ]),
  ) as Record<AgentKey, { key: AgentKey; id: string; secret: string }>,
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535)
  throw new Error("PORT must be a valid TCP port.");
