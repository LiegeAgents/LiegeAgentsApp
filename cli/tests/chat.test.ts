import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatSession, describeDraft } from "../src/chat.js";
import { isChatInvocation } from "../src/index.js";

const anna = { id: "agent-anna", name: "Anna by LiegeAgents", slug: "anna", sla_minutes: 30 };

describe("CLI chat invocation", () => {
  test("opens chat for --spg and superagents chat only", () => {
    expect(isChatInvocation(["--spg"])).toBe(true);
    expect(isChatInvocation(["superagents", "chat"])).toBe(true);
    expect(isChatInvocation(["super-agents", "chat"])).toBe(true);
    expect(isChatInvocation(["superagents", "dashboard"])).toBe(false);
    expect(isChatInvocation(["jobs", "list"])).toBe(false);
  });
});

describe("CLI chat drafts", () => {
  test("requires an enrolled agent and a budget", () => {
    const base = {
      request: "Write a brief",
      settlementAsset: "usdg" as const,
      budgetUsdg: null,
      deadlineAt: null,
    };
    expect(describeDraft({ ...base, agentName: null, budgetAmount: 5 }, [anna]).missing).toEqual([
      "which Super Agent to hire",
    ]);
    expect(
      describeDraft({ ...base, agentName: "Zed", budgetAmount: 5 }, [anna]).missing[0],
    ).toContain("Zed is not an enrolled Super Agent");
    expect(
      describeDraft({ ...base, agentName: "anna", budgetAmount: null }, [anna]).missing,
    ).toEqual(["a USDG budget"]);
    expect(describeDraft({ ...base, agentName: "Anna", budgetAmount: 5 }, [anna]).complete).toBe(
      true,
    );
  });
});

describe("CLI chat session", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let requests: Array<{ path: string; method: string; body?: Json }> = [];
  let intents: Json[] = [];
  let output: string[] = [];
  type Json = Record<string, unknown>;

  const parse = (text: string) => ({
    agentName: /anna/i.test(text) ? "Anna" : null,
    request: "Write a cited brief",
    settlementAsset: "usdg",
    budgetAmount: /5 usdg/i.test(text) ? 5 : null,
    budgetUsdg: /5 usdg/i.test(text) ? 5 : null,
    deadlineAt: null,
    confidence: 0.9,
  });

  beforeEach(() => {
    requests = [];
    intents = [];
    output = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : undefined;
      requests.push({ path, method, body });
      let data: unknown = {};
      if (path === "/v1/super-agents/dashboard") data = { agents: [anna], jobs: [] };
      if (path === "/v1/super-agents/intents/parse") data = parse(String(body?.text));
      if (path === "/v1/super-agents/intents" && method === "POST") data = { id: "intent-1" };
      if (path === "/v1/super-agents/intents" && method === "GET") data = intents;
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

  const session = async () => {
    const chat = new ChatSession((line) => output.push(line));
    await chat.start();
    return chat;
  };

  test("collects missing details across turns and only proposes after confirmation", async () => {
    const chat = await session();
    await chat.handle("Hire Anna to write a cited brief");
    expect(output.at(-1)).toContain("Still needed: a USDG budget");
    await chat.handle("budget 5 USDG");
    const parseCall = requests.filter((item) => item.path.endsWith("/intents/parse")).at(-1);
    expect(parseCall?.body?.text).toBe("Hire Anna to write a cited brief\nbudget 5 USDG");
    expect(requests.some((item) => item.path === "/v1/super-agents/intents")).toBe(false);

    await chat.handle("y");
    const created = requests.find(
      (item) => item.path === "/v1/super-agents/intents" && item.method === "POST",
    );
    expect(created?.body).toEqual({
      text: "Hire Anna to write a cited brief\nbudget 5 USDG",
      source: "cli",
    });
    expect(output.join("\n")).toContain("superagents.liegeagents.com/app?view=requests");
  });

  test("never calls decision, funding, or evaluation endpoints", async () => {
    const chat = await session();
    await chat.handle("Hire Anna for a brief, budget 5 USDG");
    await chat.handle("yes");
    intents = [{ id: "intent-1", status: "approved", job_id: "job-1", job_status: "open" }];
    await chat.poll();
    expect(requests.some((item) => /decision|fund|evaluate|submit/.test(item.path))).toBe(false);
  });

  test("declining the confirmation keeps the draft without creating a proposal", async () => {
    const chat = await session();
    await chat.handle("Hire Anna for a brief, budget 5 USDG");
    await chat.handle("n");
    expect(chat.pendingText).toBe("Hire Anna for a brief, budget 5 USDG");
    expect(requests.some((item) => item.method === "POST" && item.path.endsWith("/intents"))).toBe(
      false,
    );
  });

  test("reports dashboard approval and job progress for proposals sent from the session", async () => {
    const chat = await session();
    await chat.handle("Hire Anna for a brief, budget 5 USDG");
    await chat.handle("y");
    output = [];

    intents = [{ id: "intent-1", status: "pending", expires_at: "2999-01-01T00:00:00Z" }];
    await chat.poll();
    expect(output).toEqual([]);

    intents = [{ id: "intent-1", status: "approved", job_id: "job-1", job_status: "open" }];
    await chat.poll();
    expect(output[0]).toContain("approved in the dashboard");
    expect(output[1]).toContain("Job job-1 is open");

    intents = [{ id: "intent-1", status: "approved", job_id: "job-1", job_status: "completed" }];
    await chat.poll();
    expect(output.at(-1)).toContain("Job job-1 is completed");
    expect(chat.tracked.size).toBe(0);
  });

  test("/exit closes the session", async () => {
    const chat = await session();
    await chat.handle("/exit");
    expect(chat.closed).toBe(true);
  });
});
