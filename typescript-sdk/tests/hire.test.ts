import { describe, expect, test } from "bun:test";
import { LiegeAPIError, LiegeClient, LiegeHireClient } from "../src/index.js";

const task = (state: string, extra: Record<string, unknown> = {}) => ({
  kind: "task",
  id: "task-1",
  contextId: "task-1",
  status: {
    state,
    message: { kind: "message", role: "agent", parts: [{ kind: "text", text: `now ${state}` }] },
  },
  metadata: {
    proposalStatus: state === "submitted" ? "pending" : "approved",
    jobId: "job-1",
    jobStatus: null,
  },
  ...extra,
});

describe("LiegeHireClient", () => {
  test("lists agents, hires with a key, and waits for the delivered work", async () => {
    const calls: Array<{ url: string; auth: string | null; body?: any }> = [];
    const states = ["submitted", "working", "completed"];
    const hire = new LiegeHireClient({
      hireKey: "lmh_test",
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
        if (url.endsWith("/.well-known/agent-card.json"))
          return Response.json({
            skills: [
              {
                id: "scott",
                name: "Scott: News brief",
                description: "A brief.",
                tags: ["verified"],
                examples: [],
              },
            ],
          });
        if (body.method === "message/send")
          return Response.json({ jsonrpc: "2.0", id: 1, result: task("submitted") });
        const state = states.shift()!;
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: task(
            state,
            state === "completed"
              ? { artifacts: [{ artifactId: "a", parts: [{ kind: "text", text: "# Brief" }] }] }
              : {},
          ),
        });
      },
    });

    expect(await hire.agents()).toEqual([
      { id: "scott", name: "Scott: News brief", description: "A brief.", tags: ["verified"] },
    ]);
    const proposed = await hire.hire("Summarize this week's chain news", {
      agent: "scott",
      budget: 3,
    });
    expect(proposed).toMatchObject({
      id: "task-1",
      state: "submitted",
      message: "now submitted",
      deliverable: null,
      proposalStatus: "pending",
    });
    expect(calls[1].url).toBe("https://api.example.test/v1/a2a/scott");
    expect(calls[1].auth).toBe("Bearer lmh_test");
    expect(calls[1].body).toMatchObject({
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ kind: "text", text: "Summarize this week's chain news" }],
        },
        metadata: { budgetAmount: 3 },
      },
    });

    const done = await hire.waitForResult("task-1", { pollMs: 1 });
    expect(done).toMatchObject({ state: "completed", deliverable: "# Brief", jobId: "job-1" });
    expect(calls.at(-1)!.body).toMatchObject({ method: "tasks/get", params: { id: "task-1" } });
    expect(calls.at(-1)!.url).toBe("https://api.example.test/v1/a2a");
  });

  test("turns JSON-RPC errors into LiegeAPIError and times out while waiting", async () => {
    let reply: unknown = {
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "This key can propose at most 5 USDG per hire.",
        data: { code: "hire_cap_exceeded" },
      },
    };
    const hire = new LiegeHireClient({
      hireKey: "lmh_test",
      fetch: async () => Response.json(reply),
    });
    const error = await hire.hire("Hire Anna for a scan", { budget: 9 }).catch((e) => e);
    expect(error).toBeInstanceOf(LiegeAPIError);
    expect(error).toMatchObject({ code: "hire_cap_exceeded", status: 422 });

    reply = { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Task not found." } };
    expect(await hire.task("missing").catch((e) => e.status)).toBe(404);

    reply = { jsonrpc: "2.0", id: 1, result: task("submitted") };
    const waited = await hire.waitForResult("task-1", { timeoutMs: 0, pollMs: 1 }).catch((e) => e);
    expect(waited).toMatchObject({ code: "hire_wait_timeout" });
    expect(() => new LiegeHireClient({ hireKey: "lmp_nope" })).toThrow("hiring key");
  });

  test("LiegeClient creates, lists, and revokes hiring keys", async () => {
    const calls: Array<[string, string]> = [];
    const client = new LiegeClient({
      token: "session",
      baseUrl: "https://api.example.test",
      fetch: async (input, init) => {
        calls.push([init?.method ?? "GET", new URL(String(input)).pathname]);
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ data: init?.method === "POST" ? { id: "k1", token: "lmh_x" } : [] });
      },
    });
    expect(
      await client.createHireKey({ name: "Bot", maxBudgetPerHire: 5, dailyBudget: 20 }),
    ).toMatchObject({ token: "lmh_x" });
    await client.listHireKeys();
    await client.revokeHireKey("k1");
    expect(calls).toEqual([
      ["POST", "/v1/mcp/hire-keys"],
      ["GET", "/v1/mcp/hire-keys"],
      ["DELETE", "/v1/mcp/hire-keys/k1"],
    ]);
  });
});
