import { describe, expect, test } from "bun:test";
import { LiegeClient, McpClient } from "../src/index.js";

describe("LiegeClient", () => {
  test("lists jobs and unwraps API data", async () => {
    const client = new LiegeClient({ fetch: async () => new Response(JSON.stringify({ data: [{ id: "job-1", status: "open" }] }), { status: 200 }) });
    expect(await client.listJobs()).toEqual([{ id: "job-1", status: "open" }]);
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
