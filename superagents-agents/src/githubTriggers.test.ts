import { afterEach, describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";

const { parseGitHubPull, prepareAttachments } = await import("./attachments.js");
const { githubPolicy, postReviewComment } = await import("./githubComments.js");
const originalFetch = globalThis.fetch;
const head = "1".repeat(40);

describe("GitHub-triggered reviews", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("pull request links are recognized", () => {
    expect(parseGitHubPull("https://github.com/acme/shop/pull/7")).toEqual({
      owner: "acme",
      repo: "shop",
      number: 7,
    });
    expect(parseGitHubPull("https://github.com/acme/shop/pull/7/files")).toMatchObject({
      number: 7,
    });
    expect(parseGitHubPull("https://github.com/acme/shop")).toBeNull();
    expect(parseGitHubPull("https://gitlab.com/acme/shop/pull/7")).toBeNull();
  });

  test("the agent reads the pull request's diff, not the whole repository", async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith("/pulls/7"))
        return Response.json({
          title: "Add checkout",
          body: "Adds the checkout flow.",
          html_url: "https://github.com/acme/shop/pull/7",
          base: { ref: "main" },
          head: { sha: "2".repeat(40) },
        });
      if (url.includes("/pulls/7/files"))
        return Response.json([
          {
            filename: "src/checkout.ts",
            status: "added",
            additions: 3,
            deletions: 0,
            patch: "@@ -0,0 +1,3 @@\n+export const total = (a, b) => a + b;",
          },
          { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
        ]);
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const prepared = await prepareAttachments([
      {
        id: "l",
        kind: "link",
        name: "pr",
        mediaType: "text/uri-list",
        sizeBytes: 1,
        url: "https://github.com/acme/shop/pull/7",
        commit: head,
      },
    ]);
    expect(fetched).toEqual([
      "https://api.github.com/repos/acme/shop/pulls/7",
      "https://api.github.com/repos/acme/shop/pulls/7/files?per_page=100",
    ]);
    expect(prepared.text).toContain("Pull request #7 in acme/shop: Add checkout");
    expect(prepared.text).toContain("has moved since");
    expect(prepared.text).toContain("--- src/checkout.ts (added, +3 -0) ---");
    expect(prepared.text).toContain("+export const total");
    expect(prepared.text).toContain("logo.png (added, +0 -0) ---\n(no text diff");
    // A pull request is reviewed, never turned into a fix branch.
    expect(prepared.repositories).toEqual([]);
    expect(prepared.evidence).toEqual(["https://github.com/acme/shop/pull/7"]);
  });

  test("only well-formed trigger policies post comments", () => {
    expect(
      githubPolicy({
        github: { repository: "acme/shop", pull: 7, headSha: head, postComment: true },
      }),
    ).toEqual({ repository: "acme/shop", pull: 7, headSha: head, postComment: true });
    expect(githubPolicy({ github: { repository: "../evil", pull: 7, headSha: head } })).toBeNull();
    expect(
      githubPolicy({ github: { repository: "acme/shop", pull: "7", headSha: head } }),
    ).toBeNull();
    expect(githubPolicy({})).toBeNull();
  });

  test("the review is posted on the pull request with its commit", async () => {
    const requests: Array<{ url: string; body: { body: string }; auth: string | null }> = [];
    globalThis.fetch = (async (input: string, init: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization"),
      });
      return Response.json(
        { html_url: "https://github.com/acme/shop/pull/7#issuecomment-1" },
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const url = await postReviewComment({
      token: "bot-token",
      github: { repository: "acme/shop", pull: 7, headSha: head, postComment: true },
      agentName: "Marcus",
      deliverable: "1. High: total() ignores tax.",
    });
    expect(url).toBe("https://github.com/acme/shop/pull/7#issuecomment-1");
    expect(requests[0].url).toBe("https://api.github.com/repos/acme/shop/issues/7/comments");
    expect(requests[0].auth).toBe("Bearer bot-token");
    expect(requests[0].body.body).toContain("### Marcus's review");
    expect(requests[0].body.body).toContain("1. High: total() ignores tax.");
    expect(requests[0].body.body).toContain("Reviewed at 1111111 by Marcus");
  });
});
