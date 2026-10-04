import { config } from "./config.js";

export async function generate(system: string, user: string) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${config.groqKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: config.groqModel,
      temperature: 0.2,
      max_tokens: config.groqMaxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(config.groqTimeoutMs),
  });
  const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `Groq returned ${response.status}.`);
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Groq returned an empty response.");
  return content;
}
