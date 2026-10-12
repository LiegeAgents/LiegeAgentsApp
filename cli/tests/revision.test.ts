import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession } from "../src/chat.js";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("revisions from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];
  let output: string[] = [];

  beforeEach(() => {
    calls = [];
    output = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
      calls.push({ path, method, body });
      let data: unknown = {
        id: "job-1",
        status: "funded",
        deadline_at: "2026-10-12T14:00:00Z",
        revision_count: 1,
      };
      if (path === "/v1/super-agents/dashboard") data = { agents: [], jobs: [] };
      if (path === "/v1/jobs/job-2")
        data = { title: "Anna: market scan", status: "submitted", budget_amount: "5" };
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

  test("headless revise requires feedback and posts it", async () => {
    await expect(execute(["jobs", "revise", "job-1"])).rejects.toThrow("--feedback");
    await execute(["jobs", "revise", "job-1", "--feedback", "Add pricing."]);
    expect(calls.at(-1)).toEqual({
      path: "/v1/jobs/job-1/revision",
      method: "POST",
      body: { feedback: "Add pricing." },
    });
    await execute(["jobs", "revision", "job-1"]);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/jobs/job-1/revision", method: "GET" });
  });

  test("/revise sends multi-word feedback and /job suggests it for submitted work", async () => {
    const chat = new ChatSession((line) => output.push(line));
    await chat.start();
    await chat.handle("/job job-2");
    expect(output.join("\n")).toContain("/revise job-2 <feedback> sends it back once");
    await chat.handle("/revise job-1 Please add a pricing comparison.");
    expect(calls.at(-1)).toEqual({
      path: "/v1/jobs/job-1/revision",
      method: "POST",
      body: { feedback: "Please add a pricing comparison." },
    });
    expect(output.at(-1)).toContain("Sent back for one revision");
    await chat.handle("/revise job-1");
    expect(output.at(-1)).toContain("Usage: /revise");
  });
});
