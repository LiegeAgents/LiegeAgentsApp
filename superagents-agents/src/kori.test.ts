import { describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";

const { cleanReply, createKoriHandler, koriSystemPrompt, redactSecrets } = await import("./kori.js");

const recorder = (reply: string) => {
  const calls: Array<{ system: string; user: string }> = [];
  const generate = async (system: string, user: string) => {
    calls.push({ system, user });
    return reply;
  };
  return { calls, generate };
};

describe("Kori customer service handler", () => {
  test("keeps the calm customer service voice and honesty rules in the prompt", () => {
    expect(koriSystemPrompt).toContain("Kori by LiegeAgents");
    expect(koriSystemPrompt).toContain("Never joke when the customer is upset");
    expect(koriSystemPrompt).toContain("Never invent policies");
    expect(koriSystemPrompt).toContain("Never claim an action you did not perform");
    expect(koriSystemPrompt).toContain("Never promise to check, look into, investigate, or follow up");
    expect(koriSystemPrompt).toContain("Zero emojis");
  });

  test("sends the brief with job context and returns a cleaned deliverable", async () => {
    const { calls, generate } = recorder("<think>plan the reply</think>\nHi Ada — your order ships Monday.\n\nKori");
    const result = await createKoriHandler(generate).execute({
      jobId: "job-1",
      brief: "Customer Ada asks when order 42 ships. Policy: orders ship Monday.",
      requirements: { serviceSlug: "customer-support" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toBe(koriSystemPrompt);
    expect(calls[0].user).toContain("Job ID: job-1");
    expect(calls[0].user).toContain("Service: customer-support");
    expect(calls[0].user).toContain("order 42");
    expect(calls[0].user.endsWith("/no_think")).toBe(true);
    expect(result.deliverable).toBe("Hi Ada - your order ships Monday.\n\nKori");
    expect(result.metadata).toEqual({ model: "groq", agentKey: "kori", serviceSlug: "customer-support", redactedSecrets: 0 });
  });

  test("never forwards secrets a customer pasted into the brief", async () => {
    const key = "a".repeat(64);
    const { calls, generate } = recorder("Please move your funds to a new wallet.\n\nKori");
    const result = await createKoriHandler(generate).execute({
      jobId: "job-2",
      brief: `My wallet is empty. Private key: ${key}. Seed phrase: ${"word ".repeat(11)}word`,
      requirements: {},
    });
    expect(calls[0].user).not.toContain(key);
    expect(calls[0].user).not.toContain("word word");
    expect(calls[0].user).toContain("[REDACTED_SECRET]");
    expect(result.metadata?.redactedSecrets).toBe(2);
  });

  test("keeps transaction hashes and ordinary text intact", () => {
    const hash = `0x${"b".repeat(64)}`;
    expect(redactSecrets(`My transfer ${hash} has not arrived.`)).toEqual({ text: `My transfer ${hash} has not arrived.`, count: 0 });
    const token = ["ghp", "x".repeat(36)].join("_");
    expect(redactSecrets(`Token ${token} leaked`).text).toBe("Token [REDACTED_SECRET] leaked");
  });

  test("rejects an empty model reply instead of submitting nothing", async () => {
    const { generate } = recorder("<think>only reasoning</think>");
    await expect(createKoriHandler(generate).execute({ jobId: "job-3", brief: "Hello", requirements: {} })).rejects.toThrow("Kori returned an empty reply.");
  });

  test("surfaces model failures so the webhook can be retried", async () => {
    const generate = async () => {
      throw new Error("Groq returned 503.");
    };
    await expect(createKoriHandler(generate).execute({ jobId: "job-4", brief: "Hello", requirements: {} })).rejects.toThrow("Groq returned 503.");
  });

  test("strips reasoning blocks and long dashes from replies", () => {
    expect(cleanReply("<thought>x</thought> Thanks – we will check.")).toBe("Thanks - we will check.");
  });
});
