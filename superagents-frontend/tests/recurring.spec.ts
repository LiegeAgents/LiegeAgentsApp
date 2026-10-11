import { expect, test } from "@playwright/test";

test("approve a capped recurring job, then pause and cancel it", async ({ page }) => {
  const anna = {
    id: "agent-anna",
    name: "Anna by LiegeAgents",
    price_usd: "5",
    sla_minutes: 60,
    settlement_assets: ["usdg"],
    service_settlement_assets: ["usdg"],
  };
  let schedules: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [anna], proposals: [], jobs: [] } } });
    if (path.endsWith("/schedules") && request.method() === "GET")
      return route.fulfill({ json: { data: schedules } });
    if (path.endsWith("/schedules") && request.method() === "POST") {
      const input = request.postDataJSON();
      created.push(input);
      schedules = [
        {
          id: "schedule-1",
          agent_name: anna.name,
          request: input.request,
          settlement_asset: input.settlementAsset,
          budget_amount: String(input.budgetAmount),
          cadence: input.cadence,
          next_run_at: new Date(Date.now() + 60_000).toISOString(),
          spend_cap: String(input.spendCap),
          committed_amount: "0",
          max_runs: input.maxRuns ?? null,
          runs_count: 0,
          auto_fund: input.autoFund,
          status: "active",
          status_reason: null,
          runs: [],
        },
      ];
      return route.fulfill({ status: 201, json: { data: schedules[0] } });
    }
    if (path.endsWith("/schedule-1/pause")) {
      schedules[0] = { ...schedules[0], status: "paused", status_reason: "Paused by you." };
      return route.fulfill({ json: { data: schedules[0] } });
    }
    if (path.endsWith("/schedule-1") && request.method() === "DELETE") {
      schedules[0] = { ...schedules[0], status: "cancelled", status_reason: "Cancelled by you." };
      return route.fulfill({ json: { data: schedules[0] } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app?view=recurring");
  await expect(page.getByRole("heading", { name: "Nothing repeating yet." })).toBeVisible();
  await page.getByLabel("Agent", { exact: true }).selectOption(anna.id);
  await page.getByLabel("What should they do each time?").fill("Weekly competitor brief");
  await page.getByLabel("How often").selectOption("weekly");
  await page.getByLabel("Budget per run").fill("5");
  await page.getByLabel("Total spending cap").fill("20");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Approve recurring job" }).click();
  await expect(page.getByRole("dialog")).toContainText("Recurring job created");
  await page.getByRole("button", { name: "Got it" }).click();

  expect(created).toEqual([
    {
      agentId: anna.id,
      request: "Weekly competitor brief",
      settlementAsset: "usdg",
      budgetAmount: 5,
      cadence: "weekly",
      spendCap: 20,
      autoFund: true,
      source: "dashboard",
    },
  ]);
  await expect(page.locator(".recurring-item")).toContainText("0 of 20 USDG committed");
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.locator(".recurring-item .status")).toHaveText("paused");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".recurring-item .status")).toHaveText("cancelled");
  await expect(page.getByRole("button", { name: "Resume" })).toHaveCount(0);
});
