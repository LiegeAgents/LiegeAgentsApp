import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execute, normalizeUpgradeVersion, parseFlags, type Json } from "../src/index.js";

describe("CLI upgrade version validation", () => {
  test("normalizes supported release formats", () => {
    expect(normalizeUpgradeVersion()).toBe("latest");
    expect(normalizeUpgradeVersion("1.2.3")).toBe("cli-v1.2.3");
    expect(normalizeUpgradeVersion("v1.2.3")).toBe("cli-v1.2.3");
    expect(normalizeUpgradeVersion("cli-v1.2.3")).toBe("cli-v1.2.3");
  });

  test("rejects unsafe or ambiguous release values", () => {
    expect(() => normalizeUpgradeVersion("latest; rm -rf /")).toThrow("Upgrade version");
    expect(() => normalizeUpgradeVersion("main")).toThrow("Upgrade version");
  });
});

describe("CLI parseFlags", () => {
  test("parses flags with space and equals, separating positional arguments", () => {
    const args = [
      "services",
      "create",
      "--agent-id",
      "550e8400-e29b-41d4-a716-446655440000",
      "--slug=my-service",
      "--ap2",
      "extra-positional",
    ];
    const { flags, positional } = parseFlags(args);
    expect(positional).toEqual(["services", "create", "extra-positional"]);
    expect(flags["agent-id"]).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(flags.slug).toBe("my-service");
    expect(flags.ap2).toBe("true");
  });

  test("preserves JSON string positional arguments containing quotes and dashes", () => {
    const rawJson = '{"agentId":"550e8400-e29b-41d4-a716-446655440000","name":"Test"}';
    const args = ["services", "create", rawJson];
    const { flags, positional } = parseFlags(args);
    expect(positional).toEqual(["services", "create", rawJson]);
    expect(flags).toEqual({});
  });
});

describe("CLI account and service commands execution", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let capturedRequests: Array<{ url: string; method: string; body?: unknown; headers: Headers }> =
    [];

  beforeEach(() => {
    capturedRequests = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;

      capturedRequests.push({ url, method, body, headers });

      return new Response(JSON.stringify({ data: { success: true, url, method, body } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("agents reputation fetches /v1/agents/:slug/reputation without requiring auth", async () => {
    delete process.env.LIEGE_SESSION_TOKEN;
    await execute(["agents", "reputation", "researcher"]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe("https://api.liegeagents.com/v1/agents/researcher/reputation");
    expect(capturedRequests[0].headers.get("authorization")).toBeNull();
  });

  test("account list fetches /v1/agent-accounts with auth", async () => {
    const res = (await execute(["account", "list"])) as { success: boolean };
    expect(res.success).toBe(true);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe("https://api.liegeagents.com/v1/agent-accounts");
    expect(capturedRequests[0].headers.get("authorization")).toBe("Bearer test-session-token");
  });

  test("account status fetches /v1/agent-accounts/:agentId", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["account", "status", agentId]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}`,
    );
  });

  test("account pause posts command and optional reason", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["account", "pause", agentId, "--reason", "Emergency maintenance"]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/control`,
    );
    expect(capturedRequests[0].method).toBe("POST");
    expect(capturedRequests[0].body).toEqual({ command: "pause", reason: "Emergency maintenance" });
  });

  test("account resume posts resume command", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["account", "resume", agentId]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/control`,
    );
    expect(capturedRequests[0].method).toBe("POST");
    expect(capturedRequests[0].body).toEqual({ command: "resume" });
  });

  test("account kill posts kill command and reason", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["account", "kill", agentId, "--reason", "Compromised key"]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/control`,
    );
    expect(capturedRequests[0].method).toBe("POST");
    expect(capturedRequests[0].body).toEqual({ command: "kill", reason: "Compromised key" });
  });

  test("account mandates fetches mandates list", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["account", "mandates", agentId]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/mandates`,
    );
  });

  test("account mandates fetches single mandate and AP2 format", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    const mandateId = "660e8400-e29b-41d4-a716-446655440001";

    await execute(["account", "mandates", agentId, mandateId]);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/mandates/${mandateId}`,
    );

    await execute(["account", "mandates", agentId, mandateId, "--format", "ap2"]);
    expect(capturedRequests[1].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/mandates/${mandateId}/ap2`,
    );
  });

  test("account policy set updates policy via PUT", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["account", "policy", "set", agentId, '{"dailyBudget":50}']);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/policy`,
    );
    expect(capturedRequests[0].method).toBe("PUT");
    expect(capturedRequests[0].body).toEqual({ dailyBudget: 50 });
  });

  test("services list builds query string for filters", async () => {
    await execute(["services", "list", "--type", "tool", "--limit", "25"]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      "https://api.liegeagents.com/v1/services?type=tool&limit=25",
    );
  });

  test("services get fetches specific service by agent and slug", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["services", "get", agentId, "oracle-feed"]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/services/${agentId}/oracle-feed`,
    );
  });

  test("services create with JSON argument posts to /v1/services", async () => {
    const payload = {
      agentId: "550e8400-e29b-41d4-a716-446655440000",
      slug: "oracle-feed",
      name: "Oracle Feed",
      description: "Real-time USDG oracle feed",
      serviceType: "data",
      priceUsd: 10,
      slaMinutes: 30,
    };
    await execute(["services", "create", JSON.stringify(payload)]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe("https://api.liegeagents.com/v1/services");
    expect(capturedRequests[0].method).toBe("POST");
    expect(capturedRequests[0].body).toEqual(payload);
  });

  test("services create with CLI flags builds payload and posts", async () => {
    await execute([
      "services",
      "create",
      "--agent-id",
      "550e8400-e29b-41d4-a716-446655440000",
      "--slug",
      "oracle-feed",
      "--name",
      "Oracle Feed",
      "--description",
      "Real-time USDG oracle feed service",
      "--service-type",
      "data",
      "--price",
      "12.5",
      "--sla",
      "45",
    ]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toBe("https://api.liegeagents.com/v1/services");
    expect(capturedRequests[0].method).toBe("POST");
    expect(capturedRequests[0].body).toEqual({
      agentId: "550e8400-e29b-41d4-a716-446655440000",
      slug: "oracle-feed",
      name: "Oracle Feed",
      description: "Real-time USDG oracle feed service",
      serviceType: "data",
      executionMode: "manual",
      priceUsd: 12.5,
      slaMinutes: 45,
      requirementsSchema: {},
      deliverableSchema: {},
    });
  });

  test("services create fails when missing required fields", async () => {
    expect(execute(["services", "create", "--agent-id", "missing-rest"])).rejects.toThrow(
      "Missing required service parameters",
    );
  });
});

describe("CLI runner and proposal controls", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let capturedRequests: Array<{ url: string; method: string; body?: unknown }> = [];

  beforeEach(() => {
    capturedRequests = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      capturedRequests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const data = url.includes("/proposals/")
        ? { id: "770e8400-e29b-41d4-a716-446655440002", effective_status: "approved" }
        : {
            id: "880e8400-e29b-41d4-a716-446655440003",
            simulationId: "990e8400-e29b-41d4-a716-446655440004",
          };
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("simulates and authorizes a runner workload", async () => {
    const agentId = "550e8400-e29b-41d4-a716-446655440000";
    const workload = JSON.stringify({ command: "bun", args: ["-e", "console.log('ok')"] });
    await execute(["runner", "simulate", agentId, workload]);
    expect(capturedRequests[0].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/actions/simulate`,
    );
    expect(capturedRequests[0].body).toMatchObject({
      action: "runner.execute",
      details: { command: "bun", args: ["-e", "console.log('ok')"] },
    });

    await execute([
      "runner",
      "authorize",
      agentId,
      workload,
      "--simulation-id",
      "660e8400-e29b-41d4-a716-446655440001",
    ]);
    expect(capturedRequests[1].url).toBe(
      `https://api.liegeagents.com/v1/agent-accounts/${agentId}/actions/authorize`,
    );
    expect(capturedRequests[1].body).toMatchObject({
      action: "runner.execute",
      simulationId: "660e8400-e29b-41d4-a716-446655440001",
    });
  });

  test("submits, lists, and inspects runner executions", async () => {
    const workload = {
      agentId: "550e8400-e29b-41d4-a716-446655440000",
      command: "python",
      args: ["-c", "print('ok')"],
    };
    await execute([
      "runner",
      "execute",
      JSON.stringify(workload),
      "--action-id",
      "660e8400-e29b-41d4-a716-446655440001",
      "--simulation-id",
      "770e8400-e29b-41d4-a716-446655440002",
    ]);
    await execute(["runner", "list", "--agent-id", workload.agentId]);
    await execute(["runner", "status", "880e8400-e29b-41d4-a716-446655440003"]);
    await execute([
      "runner",
      "artifact",
      "880e8400-e29b-41d4-a716-446655440003",
      "990e8400-e29b-41d4-a716-446655440004",
    ]);
    expect(capturedRequests.map((request) => request.url)).toEqual([
      "https://api.liegeagents.com/v1/runners",
      `https://api.liegeagents.com/v1/runners?agentId=${workload.agentId}`,
      "https://api.liegeagents.com/v1/runners/880e8400-e29b-41d4-a716-446655440003",
      "https://api.liegeagents.com/v1/runners/880e8400-e29b-41d4-a716-446655440003/artifacts/990e8400-e29b-41d4-a716-446655440004",
    ]);
  });

  test("filters and waits for a terminal proposal decision", async () => {
    await execute(["proposals", "list", "--status", "pending"]);
    await execute(["proposals", "get", "770e8400-e29b-41d4-a716-446655440002"]);
    const result = (await execute([
      "proposals",
      "wait",
      "770e8400-e29b-41d4-a716-446655440002",
    ])) as Json;
    expect(capturedRequests[0].url).toBe(
      "https://api.liegeagents.com/v1/mcp/proposals?status=pending",
    );
    expect(capturedRequests[1].url).toBe(
      "https://api.liegeagents.com/v1/mcp/proposals/770e8400-e29b-41d4-a716-446655440002",
    );
    expect(result.effective_status).toBe("approved");
    expect(result.timedOut).toBe(false);
  });
});

describe("CLI job lifecycle commands", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let capturedRequests: Array<{ url: string; method: string; body?: unknown }> = [];

  beforeEach(() => {
    capturedRequests = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedRequests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("lists and fetches jobs with filters", async () => {
    const jobId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["jobs", "list", "--status", "funded", "--asset", "liege", "--limit", "25"]);
    await execute(["jobs", "get", jobId]);
    expect(capturedRequests.map((request) => request.url)).toEqual([
      "https://api.liegeagents.com/v1/jobs?status=funded&settlementAsset=liege&limit=25",
      `https://api.liegeagents.com/v1/jobs/${jobId}`,
    ]);
  });

  test("simulates, quotes, funds, submits, and evaluates a job", async () => {
    const jobId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["jobs", "simulate", '{"title":"Research","acceptanceCriteria":["Sources"]}']);
    await execute(["jobs", "funding-quote", jobId]);
    await execute([
      "jobs",
      "fund",
      jobId,
      "--quote-id",
      "660e8400-e29b-41d4-a716-446655440001",
      "--gas-tx-hash",
      "0xgas",
    ]);
    await execute([
      "jobs",
      "submit",
      jobId,
      '{"deliverable":"Report","evidence":["https://example.com/evidence"]}',
    ]);
    await execute(["jobs", "evaluate", jobId, '{"outcome":"accepted","rationale":"Pass"}']);
    expect(capturedRequests.map((request) => request.method)).toEqual([
      "POST",
      "POST",
      "POST",
      "POST",
      "POST",
    ]);
    expect(capturedRequests[2].body).toEqual({
      quoteId: "660e8400-e29b-41d4-a716-446655440001",
      gasTxHash: "0xgas",
    });
    expect(capturedRequests[3].body).toEqual({
      deliverable: "Report",
      evidence: ["https://example.com/evidence"],
    });
    expect(capturedRequests[4].body).toEqual({ outcome: "accepted", rationale: "Pass" });
  });

  test("declines a job with an explicit reason", async () => {
    const jobId = "550e8400-e29b-41d4-a716-446655440000";
    await execute(["jobs", "decline", jobId, "--reason", "The deadline is too short."]);
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toEqual({
      url: `https://api.liegeagents.com/v1/jobs/${jobId}/decline`,
      method: "POST",
      body: { reason: "The deadline is too short." },
    });
  });

  test("requires a reason when declining a job", async () => {
    await expect(execute(["jobs", "decline", "550e8400-e29b-41d4-a716-446655440000"]))
      .rejects.toThrow("--reason is required");
  });
});
