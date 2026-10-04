type AgentKey = "scott" | "anna" | "marcus" | "chloe" | "daniel";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

export const config = {
  apiUrl: required("LIEGE_API_URL").replace(/\/$/, ""),
  sessionToken: required("LIEGE_SESSION_TOKEN"),
  serverUrl: process.env.AGENT_SERVER_URL?.trim()?.replace(/\/$/, "") ?? "",
  port: Number(process.env.PORT ?? 3210),
  groqKey: required("GROQ_API_KEY"),
  groqModel: process.env.GROQ_MODEL?.trim() || "qwen/qwen3-32b",
  groqTimeoutMs: Number(process.env.GROQ_TIMEOUT_MS ?? 30_000),
  groqMaxTokens: Number(process.env.GROQ_MAX_TOKENS ?? 4_000),
  agents: Object.fromEntries(
    (["scott", "anna", "marcus", "chloe", "daniel"] as AgentKey[]).map((key) => [
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
