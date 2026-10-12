import { expect, test } from "@playwright/test";

test("connect a repository and follow the GitHub setup", async ({ page }) => {
  const marcus = {
    id: "agent-marcus",
    name: "Marcus by LiegeAgents",
    price_usd: "5",
    sla_minutes: 60,
    settlement_assets: ["usdg"],
    service_settlement_assets: ["usdg"],
  };
  const setup = {
    payloadUrl: "https://api.liegeagents.com/v1/github/hooks/trigger-1",
    contentType: "application/json",
    secret: "a".repeat(64),
    events: ["pull_request"],
    settingsUrl: "https://github.com/acme/shop/settings/hooks/new",
  };
  let triggers: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [marcus], proposals: [], jobs: [] } } });
    if (path.endsWith("/triggers") && request.method() === "GET")
      return route.fulfill({ json: { data: triggers } });
    if (path.endsWith("/triggers") && request.method() === "POST") {
      const input = request.postDataJSON();
      created.push(input);
      triggers = [
        {
          id: "trigger-1",
          agent_name: marcus.name,
          repository: input.repository,
          branch: input.branch,
          settlement_asset: "usdg",
          budget_amount: String(input.budgetAmount),
          spend_cap: String(input.spendCap),
          committed_amount: "5",
          runs_count: 1,
          auto_fund: input.autoFund,
          post_comment: input.postComment,
          verified_at: "2026-10-12T12:00:00Z",
          status: "active",
          status_reason: null,
          runs: [
            {
              id: "run-1",
              pull_number: 7,
              title: "Add checkout",
              outcome: "funded",
              detail: null,
              job_status: "submitted",
            },
          ],
        },
      ];
      return route.fulfill({ status: 201, json: { data: { ...triggers[0], setup } } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app?view=github");
  await expect(page.getByRole("heading", { name: "No repositories connected." })).toBeVisible();
  await expect(page.getByLabel("Reviewer")).toHaveValue("agent-marcus");
  await page.getByPlaceholder("owner/repository").fill("acme/shop");
  await page.getByLabel("Total spending cap").fill("50");
  await page.getByLabel("Fund reviews automatically").check();
  await page.getByRole("button", { name: "Approve and connect" }).click();

  const region = page.getByRole("region", { name: "Connect GitHub" });
  await expect(region).toContainText(setup.payloadUrl);
  await expect(region).toContainText(setup.secret);
  await expect(region.getByRole("link")).toHaveAttribute("href", setup.settingsUrl);
  expect(created).toEqual([
    {
      agentId: "agent-marcus",
      repository: "acme/shop",
      branch: "main",
      settlementAsset: "usdg",
      budgetAmount: 5,
      spendCap: 50,
      autoFund: true,
      postComment: true,
      source: "dashboard",
    },
  ]);
  await expect(page.locator(".trigger-item")).toContainText("acme/shop · main");
  await expect(page.locator(".trigger-connected")).toHaveText("Connected to GitHub");
  await expect(page.locator(".trigger-item")).toContainText(
    "#7 Add checkout: Reviewing · delivered",
  );
});
