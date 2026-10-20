import { expect, test, type Page } from "@playwright/test";

const constantine = {
  id: "agent-constantine",
  slug: "constantine",
  name: "Constantine by LiegeAgents",
  price_usd: "3",
  sla_minutes: 10,
  settlement_assets: ["usdg"],
  service_settlement_assets: ["usdg"],
};
const tokenAddress = "0x1234567890abcdef1234567890abcdef1234abcd";

const watch = (overrides: Record<string, unknown> = {}) => ({
  id: "watch-1",
  watch_token: tokenAddress,
  watch_chain: "robinhood",
  chain_name: "Robinhood Chain",
  agent_id: constantine.id,
  agent_name: constantine.name,
  settlement_asset: "usdg",
  budget_amount: "3",
  next_run_at: new Date(Date.now() + 60_000).toISOString(),
  spend_cap: "90",
  committed_amount: "0",
  max_runs: null,
  runs_count: 0,
  auto_fund: false,
  status: "active",
  status_reason: null,
  source: "dashboard",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  runs: [],
  ...overrides,
});

const run = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: `run-${id}`,
  slot: new Date().toISOString(),
  outcome: "funded",
  detail: null,
  created_at: new Date().toISOString(),
  job_id: `job-${id}`,
  job_status: "submitted",
  verdict: "Low risk",
  risk_score: 12,
  baseline: false,
  changes: [],
  checked_at: new Date().toISOString(),
  ...overrides,
});

async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
}

test("watch a token, then pause and cancel it", async ({ page }) => {
  let watches: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  const scheduleCalls: string[] = [];
  await signIn(page);
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [constantine], proposals: [], jobs: [] } } });
    if (path.endsWith("/watchlist") && request.method() === "GET")
      return route.fulfill({ json: { data: watches } });
    if (path.endsWith("/watchlist") && request.method() === "POST") {
      const input = request.postDataJSON();
      created.push(input);
      watches = [
        watch({
          watch_token: input.token,
          watch_chain: input.chain,
          chain_name: "Base",
          auto_fund: input.autoFund,
        }),
      ];
      return route.fulfill({ status: 201, json: { data: watches[0] } });
    }
    if (path.endsWith("/schedules/watch-1/pause")) {
      scheduleCalls.push(`${request.method()} pause`);
      watches[0] = { ...watches[0], status: "paused", status_reason: "Paused by you." };
      return route.fulfill({ json: { data: watches[0] } });
    }
    if (path.endsWith("/schedules/watch-1") && request.method() === "DELETE") {
      scheduleCalls.push("DELETE");
      watches[0] = { ...watches[0], status: "cancelled", status_reason: "Cancelled by you." };
      return route.fulfill({ json: { data: watches[0] } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app?view=watchlist");
  await expect(page.getByRole("heading", { name: "No tokens watched yet." })).toBeVisible();
  await expect(page.getByLabel("Budget per check")).toHaveAttribute("placeholder", "3");
  await page.getByLabel("Token address").fill(tokenAddress);
  await page.getByLabel(/^Chain/).selectOption("base");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Watch token" }).click();
  await expect(page.getByRole("dialog")).toContainText("Token added to your watchlist");
  await page.getByRole("button", { name: "Got it" }).click();

  expect(created).toEqual([
    {
      token: tokenAddress,
      chain: "base",
      settlementAsset: "usdg",
      autoFund: true,
      source: "dashboard",
    },
  ]);
  const item = page.locator(".recurring-item");
  await expect(item).toContainText("0x1234…abcd · Base");
  await expect(item).toContainText("0 of 90 USDG committed");
  await expect(item).toContainText("No check delivered yet.");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator(".recurring-item .status")).toHaveText("paused");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".recurring-item .status")).toHaveText("cancelled");
  await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
  expect(scheduleCalls).toEqual(["POST pause", "DELETE"]);
});

test("an alert is shown, and only clean delivered runs are accepted", async ({ page }) => {
  const runs = [
    // Newest first, as the API returns them.
    run("undelivered", {
      job_status: "funded",
      verdict: null,
      risk_score: null,
      baseline: null,
      checked_at: null,
    }),
    run("alert", {
      verdict: "High risk",
      risk_score: 71,
      changes: [
        {
          signal: "liquidity",
          label: "Liquidity dropped",
          detail: "Liquidity fell from 120,000 USD to 8,000 USD.",
        },
      ],
    }),
    run("clean"),
    run("accepted", { job_status: "completed" }),
    run("baseline", { baseline: true }),
  ];
  let watches = [watch({ runs, runs_count: 5, committed_amount: "15" })];
  const evaluated: { jobId: string; body: unknown }[] = [];
  await signIn(page);
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [constantine], proposals: [], jobs: [] } } });
    if (path.endsWith("/watchlist") && request.method() === "GET")
      return route.fulfill({ json: { data: watches } });
    if (path.endsWith("/watchlist/watch-1") && request.method() === "GET")
      return route.fulfill({ json: { data: watches[0] } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/v1/jobs/**", async (route) => {
    const request = route.request();
    const jobId = new URL(request.url()).pathname.match(/\/v1\/jobs\/([^/]+)\/evaluate$/)?.[1];
    if (!jobId || request.method() !== "POST") return route.fulfill({ status: 404, json: {} });
    evaluated.push({ jobId, body: request.postDataJSON() });
    watches = watches.map((item) => ({
      ...item,
      runs: (item.runs as ReturnType<typeof run>[]).map((entry) =>
        entry.job_id === jobId ? { ...entry, job_status: "completed" } : entry,
      ),
    }));
    return route.fulfill({ json: { data: { id: jobId, status: "completed" } } });
  });

  await page.goto("/app?view=watchlist");
  const item = page.locator(".recurring-item");
  await expect(item).toContainText("Latest check: High risk · risk 71/100");
  await expect(item.locator(".watch-alert")).toContainText(
    "Liquidity dropped: Liquidity fell from 120,000 USD to 8,000 USD.",
  );
  await expect(item.locator(".watch-run-alert")).toHaveCount(1);
  await expect(item.locator(".watch-tag")).toHaveText("Baseline");
  await expect(item).toContainText("Check in progress");

  await page.getByRole("button", { name: "Accept clean runs (2)" }).click();
  await expect(page.getByRole("dialog")).toContainText("Accepted 2 runs.");
  await page.getByRole("button", { name: "Got it" }).click();

  expect(evaluated).toEqual([
    {
      jobId: "job-clean",
      body: {
        outcome: "accepted",
        rationale: "No worsened signals since the last watchlist check.",
      },
    },
    {
      jobId: "job-baseline",
      body: { outcome: "accepted", rationale: "Baseline watchlist check delivered." },
    },
  ]);
  await expect(page.getByRole("button", { name: /Accept clean runs/ })).toHaveCount(0);
  await expect(item.locator(".watch-run-alert")).toContainText("awaiting your review");
});
