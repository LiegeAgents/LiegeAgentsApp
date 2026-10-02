import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { execute, parseFlags } from "../src/index.js";

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
