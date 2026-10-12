import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatSession } from "../src/chat.js";
import { attachmentMediaType, execute } from "../src/index.js";

type Call = { path: string; search: string; method: string; type: string | null; body?: unknown };

describe("attachments from the CLI", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  let calls: Call[] = [];
  let output: string[] = [];
  let dir = "";

  beforeEach(async () => {
    calls = [];
    output = [];
    dir = await mkdtemp(join(tmpdir(), "liege-attach-"));
    process.env.LIEGE_SESSION_TOKEN = "test-session-token";
    process.env.LIEGE_API_URL = "https://api.liegeagents.com";
    process.env.NO_COLOR = "1";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const type = new Headers(init?.headers).get("content-type");
      calls.push({
        path: url.pathname,
        search: url.search,
        method: init?.method ?? "GET",
        type,
        body:
          type === "application/json" && init?.body ? JSON.parse(String(init.body)) : init?.body,
      });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      let data: unknown = { id: "att-1", kind: "file", name: "brief.pdf" };
      if (url.pathname.endsWith("/attachments/att-2"))
        data = { id: "att-2", kind: "file", name: "notes.md", data: btoa("# Notes") };
      return Response.json({ data }, { status: init?.method === "POST" ? 201 : 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    await rm(dir, { recursive: true, force: true });
  });

  test("file types come from the extension; unsupported files are refused locally", () => {
    expect(attachmentMediaType("specs/Brief.PDF")).toBe("application/pdf");
    expect(attachmentMediaType("data.json")).toBe("text/plain");
    expect(() => attachmentMediaType("setup.exe")).toThrow("Attach a PDF");
  });

  test("attach uploads a file as its raw bytes, or posts a pinned link", async () => {
    const file = join(dir, "brief.pdf");
    await Bun.write(file, "%PDF-1.4");
    await execute(["jobs", "attach", "job-1", "--file", file]);
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/jobs/job-1/attachments/file",
      search: "?name=brief.pdf",
      method: "POST",
      type: "application/pdf",
    });
    await execute([
      "jobs",
      "attach",
      "job-1",
      "--url",
      "https://github.com/liegeagents/liegeagentsapp",
      "--commit",
      "d3efa0b",
    ]);
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/jobs/job-1/attachments",
      type: "application/json",
      body: { url: "https://github.com/liegeagents/liegeagentsapp", commit: "d3efa0b" },
    });
    await expect(execute(["jobs", "attach", "job-1"])).rejects.toThrow("--file <path> or --url");
    await expect(
      execute(["jobs", "attach", "job-1", "--file", join(dir, "nope.pdf")]),
    ).rejects.toThrow("No file at");
  });

  test("list, download, and detach", async () => {
    await execute(["jobs", "attachments", "job-1"]);
    expect(calls.at(-1)?.path).toBe("/v1/jobs/job-1/attachments");
    const out = join(dir, "saved.md");
    const saved = (await execute(["jobs", "attachment", "job-1", "att-2", "--out", out])) as {
      savedTo: string;
    };
    expect(saved.savedTo).toBe(out);
    expect(await Bun.file(out).text()).toBe("# Notes");
    expect(await execute(["jobs", "detach", "job-1", "att-1"])).toEqual({ removed: "att-1" });
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/jobs/job-1/attachments/att-1",
      method: "DELETE",
    });
  });

  test("/attach in the chat takes a path or a link", async () => {
    const chat = new ChatSession((line) => output.push(line));
    await chat.handle("/attach job-1 https://github.com/a/b abc1234");
    expect(calls.at(-1)?.body).toEqual({ url: "https://github.com/a/b", commit: "abc1234" });
    expect(output.join("\n")).toContain("Attached brief.pdf");
    await chat.handle("/attach job-1");
    expect(output.join("\n")).toContain("Usage: /attach");
  });
});
