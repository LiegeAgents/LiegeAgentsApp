import { afterEach, describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";

const { handlers } = await import("./handlers.js");
const { createKoriHandler } = await import("./kori.js");
const originalFetch = globalThis.fetch;

// Captures the prompt sent to Groq and answers with a fixed deliverable.
function captureGroq() {
  const prompts: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    prompts.push(body.messages[1].content);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Revised deliverable." } }] }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return prompts;
}

describe("revisions", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const revision = {
    feedback: "Compare pricing too. See https://client.example/pricing",
    previousDeliverable: "First draft citing https://invented.example/source",
  };

  test("the agent receives the feedback and its first deliverable", async () => {
    const prompts = captureGroq();
    const result = await handlers.daniel.execute({
      jobId: "job-1",
      brief: "Plan the launch.",
      requirements: {},
      revision,
    });
    expect(result.deliverable).toBe("Revised deliverable.");
    expect(prompts[0]).toContain("Plan the launch.");
    expect(prompts[0]).toContain("asked for one revision");
    expect(prompts[0]).toContain(revision.feedback);
    expect(prompts[0]).toContain(revision.previousDeliverable);
  });

  test("a first run has no revision instructions", async () => {
    const prompts = captureGroq();
    await handlers.daniel.execute({ jobId: "job-1", brief: "Plan the launch.", requirements: {} });
    expect(prompts[0]).not.toContain("revision");
  });

  test("Anna's evidence comes from the client, never from her generated first draft", async () => {
    captureGroq();
    const result = await handlers.anna.execute({
      jobId: "job-1",
      brief: "Research https://client.example/brief",
      requirements: {},
      revision,
    });
    expect(result.evidence).toEqual([
      "https://client.example/brief",
      "https://client.example/pricing",
    ]);
  });

  test("Kori revises with secrets in the feedback redacted", async () => {
    const key = "a".repeat(64);
    const prompts: string[] = [];
    const kori = createKoriHandler(async (_system, user) => {
      prompts.push(user);
      return "Revised reply.";
    });
    await kori.execute({
      jobId: "job-1",
      brief: "Customer asks about refunds.",
      requirements: { serviceSlug: "customer-support" },
      revision: { feedback: `Be warmer. Private key: ${key}`, previousDeliverable: "Hi." },
    });
    expect(prompts[0]).toContain("Be warmer.");
    expect(prompts[0]).not.toContain(key);
    expect(prompts[0]).toContain("[REDACTED_SECRET]");
  });
});
