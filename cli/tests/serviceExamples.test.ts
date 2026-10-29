import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute } from "../src/index.js";

type Json = Record<string, unknown>;

describe("service examples from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Array<{ path: string; method: string; body?: Json }> = [];

  beforeEach(() => {
    calls = [];
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Json) : undefined,
      });
      return Response.json({ data: {} });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  test("sets an example from text or a file, and clears it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "liege-example-"));
    await writeFile(join(dir, "delivery.md"), "# Brief\n- Three issuers.\n");
    await execute([
      "services",
      "example",
      "svc-1",
      "--request",
      "Research tokenized stocks.",
      "--deliverable",
      `@${join(dir, "delivery.md")}`,
    ]);
    expect(calls[0]).toEqual({
      path: "/v1/services/svc-1/example",
      method: "PATCH",
      body: {
        sampleRequest: "Research tokenized stocks.",
        sampleDeliverable: "# Brief\n- Three issuers.",
      },
    });
    await execute(["services", "example", "svc-1", "--clear"]);
    expect(calls[1].body).toEqual({ sampleRequest: null, sampleDeliverable: null });
    await expect(execute(["services", "example", "svc-1"])).rejects.toThrow("--request");
  });
});
