import { afterEach, describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";
process.env.MARCUS_GITHUB_TOKEN = "marcus-bot-token";

const { applyEdits, checkSyntax, proposeFixes } = await import("./pullRequests.js");
const { handlers } = await import("./handlers.js");
const originalFetch = globalThis.fetch;

const sha = "d3efa0bfacdf489f46b2c25bc6082c0c2c8e03e2";
const snapshot = {
  owner: "acme",
  repo: "shop",
  sha,
  files: [
    {
      path: "src/auth.ts",
      mode: "100644",
      content: 'export const check = (a: string, b: string) => a == b;\nconst secret = "x";\n',
    },
    { path: "package.json", mode: "100644", content: '{ "name": "shop" }' },
    { path: ".github/workflows/ci.yml", mode: "100644", content: "on: push\n" },
  ],
};
const noWait = async () => {};

type Call = { method: string; path: string; body?: Record<string, unknown> };

// A fake GitHub: the bot is liege-marcus, the fork appears after one retry, and the repository
// opts in to pull requests only when `optIn` is true.
function fakeGitHub(optIn: boolean, groq?: () => Response) {
  const calls: Call[] = [];
  let forkChecks = 0;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.groq.com" && groq) return groq();
    const method = init?.method ?? "GET";
    const path = url.pathname + url.search;
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/user") return Response.json({ login: "liege-marcus" });
    if (path === "/repos/acme/shop") return Response.json({ default_branch: "main" });
    if (path === "/repos/acme/shop/forks")
      return Response.json({ full_name: "liege-marcus/shop", name: "shop" }, { status: 202 });
    if (path === `/repos/liege-marcus/shop/git/commits/${sha}`)
      return ++forkChecks < 2
        ? new Response("{}", { status: 404 })
        : Response.json({ sha, tree: { sha: "base-tree" } });
    if (path === "/repos/liege-marcus/shop/git/trees") return Response.json({ sha: "new-tree" });
    if (path === "/repos/liege-marcus/shop/git/commits")
      return Response.json({ sha: "fix-commit" });
    if (path === "/repos/liege-marcus/shop/git/refs")
      return Response.json({ ref: "x" }, { status: 201 });
    if (path.startsWith("/repos/acme/shop/contents/.liege.yml"))
      return optIn
        ? Response.json({ content: Buffer.from("pull_requests: true\n").toString("base64") })
        : new Response("{}", { status: 404 });
    if (path === "/repos/acme/shop/pulls")
      return Response.json({ html_url: "https://github.com/acme/shop/pull/7" }, { status: 201 });
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return calls;
}

const fixes = {
  title: "Use constant-time comparison",
  summary: "Fixes the timing leak from the review.",
  edits: [
    {
      path: "src/auth.ts",
      find: "a == b",
      replace: "a.length === b.length && timingSafe(a, b)",
      reason: "Constant-time comparison.",
    },
    { path: "package.json", find: "shop", replace: "shop2", reason: "rename" },
  ],
};

describe("Marcus pull requests", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("changed files must still parse", () => {
    expect(checkSyntax("a.ts", "const x: number = 1;")).toBeNull();
    expect(checkSyntax("a.tsx", "export const A = () => <div />;")).toBeNull();
    expect(checkSyntax("a.ts", "const x = ;")).not.toBeNull();
    expect(checkSyntax("a.json", "{ bad")).not.toBeNull();
    expect(checkSyntax("a.py", "def (")).toBeNull();
  });

  test("edits apply only once, only to read files, never to CI or dependency files", () => {
    const { changes, applied, skipped } = applyEdits(snapshot, [
      { path: "src/auth.ts", find: "a == b", replace: "a === b", reason: "strict" },
      { path: "src/auth.ts", find: "missing", replace: "x", reason: "" },
      { path: "src/other.ts", find: "a", replace: "b", reason: "" },
      { path: ".github/workflows/ci.yml", find: "push", replace: "pull_request", reason: "" },
      { path: "package.json", find: "shop", replace: "shop2", reason: "" },
      { path: "src/auth.ts", find: 'const secret = "x";', replace: "const secret = ;", reason: "" },
    ]);
    expect(applied.map((edit) => edit.reason)).toEqual(["strict"]);
    expect(changes).toEqual([
      {
        path: "src/auth.ts",
        mode: "100644",
        content: 'export const check = (a: string, b: string) => a === b;\nconst secret = "x";\n',
      },
    ]);
    expect(skipped).toHaveLength(5);
    expect(skipped.join(" ")).toContain("did not parse");
  });

  test("an opted-in repository gets a pull request from the bot's fork", async () => {
    const calls = fakeGitHub(true);
    const result = await proposeFixes({
      jobId: "12345678-aaaa",
      review: "Timing leak in check().",
      snapshot,
      token: "t",
      generate: async () => fixes,
      wait: noWait,
    });
    expect(result).toMatchObject({
      status: "pull_request",
      url: "https://github.com/acme/shop/pull/7",
      commitSha: "fix-commit",
      checked: 1,
    });
    const tree = calls.find((call) => call.path === "/repos/liege-marcus/shop/git/trees");
    expect(tree?.body).toMatchObject({
      base_tree: "base-tree",
      tree: [{ path: "src/auth.ts", mode: "100644", type: "blob" }],
    });
    const commit = calls.find((call) => call.path === "/repos/liege-marcus/shop/git/commits");
    expect(commit?.body).toMatchObject({ parents: [sha] });
    const pull = calls.find((call) => call.path === "/repos/acme/shop/pulls");
    expect(pull?.body).toMatchObject({ base: "main", maintainer_can_modify: true });
    expect(String(pull?.body?.head)).toMatch(/^liege-marcus:liege\/marcus-12345678-/);
    expect(String(pull?.body?.body)).toContain("tests were not run");
    // Nothing is ever written to the client's repository except the pull request.
    expect(
      calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path.startsWith("/repos/acme/shop/") &&
          !["/repos/acme/shop/forks", "/repos/acme/shop/pulls"].includes(call.path),
      ),
    ).toEqual([]);
  });

  test("other repositories get a one-click link instead of an unsolicited pull request", async () => {
    const calls = fakeGitHub(false);
    const result = await proposeFixes({
      jobId: "12345678-aaaa",
      review: "Timing leak.",
      snapshot,
      token: "t",
      generate: async () => fixes,
      wait: noWait,
    });
    expect(result.status).toBe("branch");
    expect("url" in result && result.url).toMatch(
      /^https:\/\/github\.com\/acme\/shop\/compare\/main\.\.\.liege-marcus:shop:liege\/marcus-12345678-[a-z0-9]+\?expand=1$/,
    );
    expect(calls.some((call) => call.path === "/repos/acme/shop/pulls")).toBe(false);
  });

  test("no applicable edits means no branch at all", async () => {
    const calls = fakeGitHub(true);
    const result = await proposeFixes({
      jobId: "12345678-aaaa",
      review: "Looks good.",
      snapshot,
      token: "t",
      generate: async () => ({ title: "x", edits: [] }),
    });
    expect(result).toMatchObject({ status: "none", reason: "No code changes were needed." });
    expect(calls).toEqual([]);
  });

  test("Marcus's deliverable links the pull request and cites it as evidence", async () => {
    let groqCalls = 0;
    fakeGitHub(true, () =>
      Response.json({
        choices: [
          {
            message: {
              content:
                ++groqCalls === 1 ? "Review: timing leak in check()." : JSON.stringify(fixes),
            },
          },
        ],
      }),
    );
    const milestones: string[] = [];
    const result = await handlers.marcus.execute({
      jobId: "12345678-bbbb",
      brief: "Review my repo.",
      requirements: {},
      attachments: {
        text: "",
        images: [],
        evidence: [`https://github.com/acme/shop/tree/${sha}`],
        notes: [],
        repositories: [snapshot],
      },
      report: async (_stage, message) => {
        milestones.push(message);
      },
    });
    expect(result.deliverable).toContain(
      "I opened a pull request with these fixes: https://github.com/acme/shop/pull/7",
    );
    expect(result.deliverable).toContain("your tests were not run");
    expect(result.evidence).toEqual([
      "https://github.com/acme/shop/pull/7",
      `https://github.com/acme/shop/tree/${sha}`,
    ]);
    expect(milestones).toEqual(["Marcus is writing fixes and checking that they parse."]);
  });

  test("a GitHub failure still delivers the review", async () => {
    let groqCalls = 0;
    globalThis.fetch = (async (input: string) =>
      new URL(String(input)).hostname === "api.groq.com"
        ? Response.json({
            choices: [
              { message: { content: ++groqCalls === 1 ? "Review text." : JSON.stringify(fixes) } },
            ],
          })
        : new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const result = await handlers.marcus.execute({
      jobId: "12345678-cccc",
      brief: "Review.",
      requirements: {},
      attachments: { text: "", images: [], evidence: [], notes: [], repositories: [snapshot] },
    });
    expect(result.deliverable).toContain("Review text.");
    expect(result.deliverable).toContain("could not prepare a pull request");
  });
});
