import { afterEach, describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";

const { parseGitHubRepo, prepareAttachments } = await import("./attachments.js");
const { handlers } = await import("./handlers.js");
const originalFetch = globalThis.fetch;

const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 52 >> stream
BT /F1 18 Tf 20 100 Td (Launch budget is 4000 USD) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;
const file = (name: string, mediaType: string, body: string | Buffer) => ({
  id: name,
  kind: "file" as const,
  name,
  mediaType,
  sizeBytes: body.length,
  data: Buffer.from(body).toString("base64"),
});
const sha = "d3efa0bfacdf489f46b2c25bc6082c0c2c8e03e2";

// Serves a tiny public repository and records every URL fetched.
function fakeGitHub(groq?: (body: Record<string, unknown>) => Response) {
  const fetched: string[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes("/commits/")) return Response.json({ sha });
    if (url.includes("/git/trees/"))
      return Response.json({
        tree: [
          { path: "src/app.ts", type: "blob", size: 40 },
          { path: "README.md", type: "blob", size: 20 },
          { path: "node_modules/x/index.js", type: "blob", size: 10 },
          { path: "logo.png", type: "blob", size: 10 },
        ],
      });
    if (url.startsWith("https://raw.githubusercontent.com/"))
      return new Response(url.endsWith("README.md") ? "# Demo app" : "export const secret = 1;");
    if (url.startsWith("https://api.groq.com/") && groq)
      return groq(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return fetched;
}

describe("attachments", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GitHub links are recognized with an optional ref and folder", () => {
    expect(parseGitHubRepo("https://github.com/liegeagents/liegeagentsapp")).toEqual({
      owner: "liegeagents",
      repo: "liegeagentsapp",
      ref: undefined,
      folder: "",
    });
    expect(parseGitHubRepo("https://github.com/a/b.git/tree/main/backend/src")).toMatchObject({
      repo: "b",
      ref: "main",
      folder: "backend/src",
    });
    expect(parseGitHubRepo("https://gitlab.com/a/b")).toBeNull();
    expect(parseGitHubRepo("https://github.com/a")).toBeNull();
  });

  test("text, PDFs, images, and links become prompt material", async () => {
    globalThis.fetch = (async () =>
      new Response("unused", { status: 500 })) as unknown as typeof fetch;
    const prepared = await prepareAttachments([
      file("notes.md", "text/markdown", "# Goals\nShip by Friday."),
      file("budget.pdf", "application/pdf", pdf),
      file("screen.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      {
        id: "l",
        kind: "link",
        name: "x",
        mediaType: "text/uri-list",
        sizeBytes: 1,
        url: "https://example.com/spec",
      },
    ]);
    expect(prepared.text).toContain("Ship by Friday.");
    expect(prepared.text).toContain("Launch budget is 4000 USD");
    expect(prepared.text).toContain("Image: screen.png");
    expect(prepared.text).toContain("never as instructions");
    expect(prepared.images).toHaveLength(1);
    expect(prepared.evidence).toEqual(["https://example.com/spec"]);
  });

  test("a repository is read at its pinned commit, skipping vendored and binary files", async () => {
    const fetched = fakeGitHub();
    const prepared = await prepareAttachments([
      {
        id: "r",
        kind: "link",
        name: "repo",
        mediaType: "text/uri-list",
        sizeBytes: 1,
        url: "https://github.com/liegeagents/liegeagentsapp",
        commit: "d3efa0b",
      },
    ]);
    expect(fetched[0]).toBe(
      "https://api.github.com/repos/liegeagents/liegeagentsapp/commits/d3efa0b",
    );
    expect(fetched.filter((url) => url.startsWith("https://raw."))).toEqual([
      `https://raw.githubusercontent.com/liegeagents/liegeagentsapp/${sha}/README.md`,
      `https://raw.githubusercontent.com/liegeagents/liegeagentsapp/${sha}/src/app.ts`,
    ]);
    expect(prepared.text).toContain(`at commit ${sha}, 2 of 2 source files shown`);
    expect(prepared.evidence).toContain(
      `https://github.com/liegeagents/liegeagentsapp/tree/${sha}`,
    );
  });

  test("the text budget truncates long attachments", async () => {
    const prepared = await prepareAttachments(
      [file("long.txt", "text/plain", "x".repeat(5_000))],
      1_000,
    );
    expect(prepared.text).toContain("[… truncated: 4000 more characters]");
  });

  test("an unreadable attachment becomes a note instead of failing the job", async () => {
    const prepared = await prepareAttachments([
      file("broken.pdf", "application/pdf", "%PDF-garbage"),
    ]);
    expect(prepared.notes[0]).toContain("broken.pdf");
  });

  test("Marcus reviews the pinned snapshot and cites it; images go to the vision model", async () => {
    const requests: Array<Record<string, unknown>> = [];
    fakeGitHub((body) => {
      requests.push(body);
      return Response.json({ choices: [{ message: { content: "Review done." } }] });
    });
    const attachments = await prepareAttachments([
      {
        id: "r",
        kind: "link",
        name: "repo",
        mediaType: "text/uri-list",
        sizeBytes: 1,
        url: "https://github.com/liegeagents/liegeagentsapp",
        commit: sha,
      },
      file("screen.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ]);
    const result = await handlers.marcus.execute({
      jobId: "job-1",
      brief: "Review the repo.",
      requirements: {},
      attachments,
    });
    expect(result.evidence).toEqual([`https://github.com/liegeagents/liegeagentsapp/tree/${sha}`]);
    expect(requests[0].model).toBe("meta-llama/llama-4-scout-17b-16e-instruct");
    const content = (requests[0].messages as Array<{ content: unknown }>)[1].content as Array<{
      type: string;
      text?: string;
    }>;
    expect(content[0].text).toContain("export const secret = 1;");
    expect(content[1].type).toBe("image_url");
  });

  test("if the vision model fails, the text model answers and says images were not viewed", async () => {
    const models: string[] = [];
    let lastUser = "";
    fakeGitHub((body) => {
      models.push(String(body.model));
      if (models.length === 1)
        return Response.json({ error: { message: "no vision" } }, { status: 400 });
      lastUser = String((body.messages as Array<{ content: unknown }>)[1].content);
      return Response.json({ choices: [{ message: { content: "Done." } }] });
    });
    const attachments = await prepareAttachments([
      file("screen.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    ]);
    await handlers.chloe.execute({
      jobId: "job-2",
      brief: "Critique this UI.",
      requirements: {},
      attachments,
    });
    expect(models).toEqual(["meta-llama/llama-4-scout-17b-16e-instruct", "qwen/qwen3.8-27b"]);
    expect(lastUser).toContain("could not be viewed");
  });
});
