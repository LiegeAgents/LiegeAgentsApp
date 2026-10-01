import { describe, expect, test } from "bun:test";
import { LiegeAPIError, LiegeClient, McpClient } from "../src/index.js";

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

  test("creates an invoice through the authenticated API client", async () => {
    const client = new LiegeClient({ token: "session", fetch: async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer session" });
      return new Response(JSON.stringify({ data: { id: "invoice-1", invoiceId: "invoice-1", publicId: "INV-1", amountUsdg: 12.5, asset: "usdg", status: "issued" } }));
    } });
    await expect(client.createInvoice({ agentId: "agent-1", description: "Research", amountUsdg: 12.5, expiresAt: "2030-01-01T00:00:00.000Z" })).resolves.toMatchObject({ id: "invoice-1", status: "issued" });
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
