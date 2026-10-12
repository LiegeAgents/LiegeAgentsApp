import { expect, test } from "@playwright/test";

test("start a squad from a template and watch it hand off", async ({ page }) => {
  const agent = (id: string, name: string, price: string) => ({
    id,
    name,
    price_usd: price,
    sla_minutes: 60,
    settlement_assets: ["usdg"],
    service_settlement_assets: ["usdg"],
  });
  const agents = [
    agent("agent-anna", "Anna by LiegeAgents", "2"),
    agent("agent-daniel", "Daniel by LiegeAgents", "3"),
    agent("agent-scott", "Scott by LiegeAgents", "4"),
  ];
  let squads: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents, proposals: [], jobs: [] } } });
    if (path.endsWith("/squads") && request.method() === "GET")
      return route.fulfill({ json: { data: squads } });
    if (path.endsWith("/squads") && request.method() === "POST") {
      const input = request.postDataJSON();
      created.push(input);
      const names = ["Anna", "Daniel", "Scott"];
      squads = [
        {
          id: "squad-1",
          name: input.name,
          settlement_asset: input.settlementAsset,
          total_budget: "9",
          auto_fund: input.autoFund,
          status: "running",
          status_reason: null,
          steps: input.steps.map((step: { task: string; budgetAmount: number }, index: number) => ({
            position: index,
            agent_name: names[index],
            task: step.task,
            budget_amount: step.budgetAmount,
            job_id: index === 0 ? "job-1" : null,
            job_status: index === 0 ? "funded" : null,
            detail: null,
            progress: index === 0 ? { message: "Anna is reading your 0 attachments." } : null,
          })),
        },
      ];
      return route.fulfill({ status: 201, json: { data: squads[0] } });
    }
    if (path.endsWith("/squad-1/cancel")) {
      squads[0] = { ...squads[0], status: "cancelled", status_reason: "Cancelled by you." };
      return route.fulfill({ json: { data: squads[0] } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app?view=squads");
  await expect(page.getByRole("heading", { name: "No squads yet." })).toBeVisible();
  await page.getByRole("button", { name: /Product launch/ }).click();
  await expect(page.getByLabel("Step 3 task")).toHaveValue("Write the launch copy");
  await page.getByLabel("What should the squad deliver?").fill("Plan the launch of Notely.");
  await page.getByRole("checkbox").check();
  await expect(page.locator(".squad-total strong")).toHaveText("9 USDG");
  await page.getByRole("button", { name: "Approve squad" }).click();
  await expect(page.getByRole("dialog")).toContainText("Squad started");
  await page.getByRole("button", { name: "Got it" }).click();

  expect(created).toEqual([
    {
      name: "Product launch",
      request: "Plan the launch of Notely.",
      settlementAsset: "usdg",
      autoFund: true,
      source: "dashboard",
      steps: [
        {
          agentId: "agent-anna",
          task: "Research the market and the main competitors",
          budgetAmount: 2,
        },
        { agentId: "agent-daniel", task: "Turn the research into a launch plan", budgetAmount: 3 },
        { agentId: "agent-scott", task: "Write the launch copy", budgetAmount: 4 },
      ],
    },
  ]);
  await expect(page.locator(".squad-stage").first()).toContainText("Working");
  await expect(page.locator(".squad-stage").nth(1)).toContainText("Queued");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".squad-item .status")).toHaveText("cancelled");
});
