import { describe, expect, test } from "bun:test";
import { LiegeAPIError, LiegeClient, McpClient, decodeX402PaymentRequired } from "../src/index.js";

describe("LiegeClient", () => {
  test("lists jobs and unwraps API data", async () => {
    const client = new LiegeClient({ fetch: async () => new Response(JSON.stringify({ data: [{ id: "job-1", status: "open" }] }), { status: 200 }) });
    expect(await client.listJobs()).toEqual([{ id: "job-1", status: "open" }]);
  });

  test("authenticates with an application-provided signer", async () => {
    const client = new LiegeClient({ fetch: async (_input, init) => {
      const path = new URL(String(_input)).pathname;
      if (path.endsWith("/nonce")) return new Response(JSON.stringify({ data: { nonce: "n1", message: "sign me" } }));
      return new Response(JSON.stringify({ data: { token: "session", userId: "u1", walletAddress: "0xabc" } }));
    } });
    const session = await client.authenticate("0xabc", (message) => `sig:${message}`);
    expect(session.token).toBe("session");
  });

  test("surfaces structured API errors", async () => {
    const client = new LiegeClient({ fetch: async () => new Response(JSON.stringify({ error: { message: "Denied", code: "POLICY" } }), { status: 403 }) });
    await expect(client.listJobs()).rejects.toBeInstanceOf(LiegeAPIError);
  });

  test("keeps the final SSE event when the stream has no blank terminator", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('id: 1\nevent: job\ndata: {"id":"job-1"}\n')); controller.close(); } });
    const client = new LiegeClient({ token: "session", fetch: async () => new Response(stream) });
    const events = []; for await (const event of client.iterEvents("agent-1")) events.push(event);
    expect(events).toEqual([{ id: "1", event: "job", data: { id: "job-1" } }]);
  });

  test("reconnects with Last-Event-ID and deduplicates replayed events", async () => {
    let calls = 0;
    const client = new LiegeClient({ fetch: async (input, init) => {
      calls++;
      const url = new URL(String(input));
      if (calls === 1) {
        expect(url.searchParams.get("after")).toBe("1");
        expect(new Headers(init?.headers).get("Last-Event-ID")).toBe("1");
        return new Response('id: 1\nevent: job.funded\ndata: {"jobId":"j1"}\n\n');
      }
      return new Response('id: 1\nevent: job.funded\ndata: {"jobId":"j1"}\n\nid: 2\nevent: job.completed\ndata: {"jobId":"j1"}\n\n');
    } });
    const stream = client.streamEvents("agent-1", { after: "1", maxRetries: 1, backoffMs: 0 });
    const first = await stream.next();
    const second = await stream.next();
    await stream.return?.();
    expect([first.value.id, second.value.id]).toEqual(["1", "2"]);
    expect(calls).toBe(2);
  });

  test("creates an invoice through the authenticated API client", async () => {
    const client = new LiegeClient({ token: "session", fetch: async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer session" });
      const body = JSON.parse(String(init?.body));
      if (body.asset === "liege") {
        return new Response(JSON.stringify({ data: { id: "invoice-2", invoiceId: "invoice-2", publicId: "INV-2", amount: 100, amountUsdg: 100, asset: "liege", status: "issued" } }));
      }
      return new Response(JSON.stringify({ data: { id: "invoice-1", invoiceId: "invoice-1", publicId: "INV-1", amountUsdg: 12.5, asset: "usdg", status: "issued" } }));
    } });
    await expect(client.createInvoice({ agentId: "agent-1", description: "Research", amountUsdg: 12.5, expiresAt: "2030-01-01T00:00:00.000Z" })).resolves.toMatchObject({ id: "invoice-1", status: "issued" });
    await expect(client.createInvoice({ agentId: "agent-1", description: "Audit", amount: 100, asset: "liege", expiresAt: "2030-01-01T00:00:00.000Z" })).resolves.toMatchObject({ id: "invoice-2", asset: "liege" });
  });

  test("supports partial refunds bound to jobId and reason and lists refunds", async () => {
    const client = new LiegeClient({ token: "session", fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/invoices/inv-1/refund")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ amount: 5, jobId: "00000000-0000-0000-0000-000000000001", reason: "Scope adjusted" });
        return new Response(JSON.stringify({ data: { id: "inv-1", invoiceId: "inv-1", publicId: "INV-1", amount: 10, amountUsdg: 10, refundedAmount: 5, refundedAmountUsdg: 5, remainingAmount: 5, asset: "usdg", status: "partially_refunded" } }));
      }
      if (url.endsWith("/v1/invoices/inv-1/refunds")) {
        return new Response(JSON.stringify({ data: [{ id: "ref-1", invoiceId: "inv-1", payerId: "payer-1", issuerId: "issuer-1", amount: 5, amountUsdg: 5, asset: "usdg", jobId: "00000000-0000-0000-0000-000000000001", reason: "Scope adjusted", refundedAt: "2026-10-02T12:00:00Z", ledgerTransactionId: "tx-1" }] }));
      }
      return new Response("not found", { status: 404 });
    } });
    const refunded = await client.refundInvoice("inv-1", { amount: 5, jobId: "00000000-0000-0000-0000-000000000001", reason: "Scope adjusted" });
    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.refundedAmount).toBe(5);
    expect(refunded.remainingAmount).toBe(5);
    const refunds = await client.listInvoiceRefunds("inv-1");
    expect(refunds).toHaveLength(1);
    expect(refunds[0].jobId).toBe("00000000-0000-0000-0000-000000000001");
    expect(refunds[0].reason).toBe("Scope adjusted");
  });

  test("lists and creates typed catalog services", async () => {
    let calls = 0;
    const client = new LiegeClient({ token: "session", fetch: async (input, init) => {
      calls++;
      if (calls === 1) {
        expect(new URL(String(input)).searchParams.get("type")).toBe("skill");
        return new Response(JSON.stringify({ data: [{ id: "svc-1", agent_id: "agent-1", slug: "research", name: "Research", description: "A research service for agents.", service_type: "skill", execution_mode: "sandboxed_runner", price_usd: "2.50", sla_minutes: 30, requirements_schema: {}, deliverable_schema: {} }] }));
      }
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { id: "svc-2", agentId: "agent-1", slug: "lookup", name: "Lookup", description: "A lookup service for agents.", serviceType: "tool", executionMode: "manual", priceUsd: 1, slaMinutes: 15, requirementsSchema: {}, deliverableSchema: {} } }));
    } });
    const [service] = await client.listServices({ type: "skill" });
    const created = await client.createService({ agentId: "agent-1", slug: "lookup", name: "Lookup", description: "A lookup service for agents.", serviceType: "tool", priceUsd: 1, slaMinutes: 15 });
    expect(service).toMatchObject({ agentId: "agent-1", serviceType: "skill", executionMode: "sandboxed_runner", priceUsd: 2.5 });
    expect(created.serviceType).toBe("tool");
  });

  test("simulates and authorizes an agent action", async () => {
    let calls = 0;
    const client = new LiegeClient({ token: "session", fetch: async (input, init) => {
      calls++;
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/actions/simulate")) return new Response(JSON.stringify({ data: { id: "sim-1", action_digest: "digest-1234", action: { action: "run" }, result: { eligible: true }, policy_version: 2, expires_at: "2030-01-01T00:00:00Z", created_at: "2030-01-01T00:00:00Z" } }), { status: 201 });
      expect(path.endsWith("/actions/authorize")).toBe(true);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ data: { actionId: "action-1", accountId: "agent-1", decision: "approval_required", reasons: [], policyVersion: 2, simulationDigest: "digest-1234", createdAt: "2030-01-01T00:00:00Z" } }));
    } });
    const simulation = await client.simulateAction("agent-1", { action: "run", amount: 1 });
    const authorization = await client.authorizeAction("agent-1", { action: "run", amount: 1, simulationId: simulation.id });
    expect(simulation.actionDigest).toBe("digest-1234");
    expect(authorization.decision).toBe("approval_required");
    expect(calls).toBe(2);
  });

  test("completes an x402 challenge with an application-provided signer", async () => {
    let attempts = 0;
    const challenge = { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:4663" }] };
    const client = new LiegeClient({ fetch: async (_input, init) => {
      attempts++;
      if (attempts === 1) return new Response("pay", { status: 402, headers: { "PAYMENT-REQUIRED": btoa(JSON.stringify(challenge)) } });
      expect(new Headers(init?.headers).get("PAYMENT-SIGNATURE")).toBe(btoa(JSON.stringify({ payload: "signed" })));
      return new Response(JSON.stringify({ paid: true }), { status: 200, headers: { "PAYMENT-RESPONSE": btoa(JSON.stringify({ success: true })) } });
    } });
    const response = await client.requestX402("https://api.test/resource", (value) => {
      expect(value).toEqual(decodeX402PaymentRequired(btoa(JSON.stringify(challenge))));
      return { payload: "signed" };
    });
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });
});

describe("McpClient", () => {
  test("initializes and proposes an action", async () => {
    const methods: string[] = [];
    const client = new McpClient("lmp_test", "https://mcp.test", async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      methods.push(request.method);
      const result = request.method === "tools/call"
        ? { content: [{ type: "text", text: JSON.stringify({ id: "proposal-1", status: "pending" }) }] }
        : {};
      return new Response(JSON.stringify({ result }), { status: 200 });
    });
    expect(await client.propose("submit_deliverable", { jobId: "job-1" })).toMatchObject({ id: "proposal-1", status: "pending" });
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  test("interacts with account status, simulation, authorization, and services", async () => {
    const toolCalls: string[] = [];
    const client = new McpClient("lmp_test", "https://mcp.test", async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
      if (request.method === "tools/call") {
        toolCalls.push(request.params?.name ?? "");
        const responses: Record<string, unknown> = {
          liege_account_status: { accountId: "agent-1", status: "active", budgetUsage: { dailySpent: 0 } },
          liege_account_simulate: { simulationId: "sim-1", actionDigest: "dig-1", result: { eligible: true } },
          liege_account_authorize: { actionId: "act-1", decision: "approved" },
          liege_account_mandates: [{ id: "man-1", nonce: "nonce-1" }],
          list_services: [{ id: "srv-1", name: "Market Data" }],
        };
        const text = JSON.stringify(responses[request.params?.name ?? ""] ?? {});
        return new Response(JSON.stringify({ result: { content: [{ type: "text", text }] } }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    });

    const status = await client.accountStatus();
    expect(status).toMatchObject({ accountId: "agent-1", status: "active" });

    const sim = await client.accountSimulate({ action: "transfer", amount: 10 });
    expect(sim).toMatchObject({ simulationId: "sim-1", actionDigest: "dig-1" });

    const auth = await client.accountAuthorize({ action: "transfer", amount: 10, simulationId: "sim-1" });
    expect(auth).toMatchObject({ actionId: "act-1", decision: "approved" });

    const mandates = await client.accountMandates();
    expect(mandates).toHaveLength(1);
    expect(mandates[0]).toMatchObject({ id: "man-1" });

    const services = await client.listServices();
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ id: "srv-1" });

    expect(toolCalls).toEqual([
      "liege_account_status",
      "liege_account_simulate",
      "liege_account_authorize",
      "liege_account_mandates",
      "list_services",
    ]);
  });
});
