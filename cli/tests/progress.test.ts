import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession } from "../src/chat.js";

type Json = Record<string, unknown>;

describe("live job progress in the chat", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let intents: Json[] = [];
  let job: Json = {};
  let output: string[] = [];

  beforeEach(() => {
    output = [];
    intents = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      let data: unknown = {};
      if (path === "/v1/super-agents/dashboard") data = { agents: [], jobs: [] };
      if (path === "/v1/super-agents/intents") data = intents;
      if (path === "/v1/jobs/job-1") data = job;
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  const step = (message: string, percent: number | null, at: string) => ({
    stage: "drafting",
    message,
    percent,
    created_at: at,
  });

  test("each new milestone is shown once while the job runs", async () => {
    const chat = new ChatSession((line) => output.push(line));
    await chat.start();
    chat.tracked.set("intent-1", { intentStatus: "approved", jobId: "job-1", jobStatus: "funded" });
    output = [];

    intents = [
      {
        id: "intent-1",
        status: "approved",
        job_id: "job-1",
        job_status: "funded",
        progress: step("Anna picked up your job.", 10, "2026-10-12T10:00:00Z"),
      },
    ];
    await chat.poll();
    await chat.poll();
    intents[0].progress = step("Anna is working on your deliverable.", 40, "2026-10-12T10:00:05Z");
    await chat.poll();
    expect(output).toEqual([
      "  › Anna picked up your job. (10%)",
      "  › Anna is working on your deliverable. (40%)",
    ]);
  });

  test("/job prints the progress trail", async () => {
    job = {
      title: "Anna: market scan",
      status: "funded",
      budget_amount: "5",
      settlement_asset: "usdg",
      progress: [
        step("Anna picked up your job.", 10, "2026-10-12T10:00:00Z"),
        step("Anna is working on your deliverable.", null, "2026-10-12T10:00:05Z"),
      ],
    };
    const chat = new ChatSession((line) => output.push(line));
    await chat.start();
    await chat.handle("/job job-1");
    const text = output.join("\n");
    expect(text).toContain("Progress");
    expect(text).toContain("Anna picked up your job. (10%)");
    expect(text).toContain("Anna is working on your deliverable.");
    expect(text).not.toContain("null");
  });
});
