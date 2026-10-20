import { afterEach, describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";

const { reportProgress, submitDeliverable } = await import("./liege-client.js");
const originalFetch = globalThis.fetch;

describe("progress reports", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("post the milestone with the scoped runtime token", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ data: {} }), { status: 201 });
    }) as unknown as typeof fetch;
    await reportProgress("job-1", "drafting", "Anna is working on your deliverable.", 40);
    expect(sent!.url).toBe("https://api.example.com/v1/jobs/job-1/progress");
    const headers = new Headers(sent!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer runtime-token");
    expect(headers.get("x-liege-runtime-token")).toBe("1");
    expect(JSON.parse(String(sent!.init.body))).toEqual({
      stage: "drafting",
      message: "Anna is working on your deliverable.",
      percent: 40,
    });
  });

  test("never throw, so a rejected or failed report cannot block the job", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "limit" } }), {
        status: 409,
      })) as unknown as typeof fetch;
    await expect(reportProgress("job-1", "started", "Picked up.")).resolves.toBeUndefined();
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(reportProgress("job-1", "started", "Picked up.")).resolves.toBeUndefined();
  });
});

describe("deliveries", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("carry a watch result only when the handler produced one", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ data: { id: "job-1", status: "submitted" } }));
    }) as unknown as typeof fetch;
    await submitDeliverable("job-1", "# Report", ["https://example.com/source"]);
    await submitDeliverable("job-1", "# Report", [], { version: 1, verdict: "Caution" });
    expect(bodies).toEqual([
      { deliverable: "# Report", evidence: ["https://example.com/source"] },
      { deliverable: "# Report", evidence: [], watch: { version: 1, verdict: "Caution" } },
    ]);
  });
});
