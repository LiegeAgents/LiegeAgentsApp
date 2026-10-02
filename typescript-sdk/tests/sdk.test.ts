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
      return new Response(JSON.stringify({ data: { id: "invoice-1", invoiceId: "invoice-1", publicId: "INV-1", amountUsdg: 12.5, asset: "usdg", status: "issued" } }));
    } });
    await expect(client.createInvoice({ agentId: "agent-1", description: "Research", amountUsdg: 12.5, expiresAt: "2030-01-01T00:00:00.000Z" })).resolves.toMatchObject({ id: "invoice-1", status: "issued" });
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
});
