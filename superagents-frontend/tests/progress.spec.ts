import { expect, test } from "@playwright/test";

test("a funded request shows the agent's live progress", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({
        json: {
          data: {
            agents: [],
            jobs: [],
            proposals: [
              {
                id: "intent-live",
                raw_text: "Hire Anna for a market scan, budget 5 USDG",
                parsed: { request: "Market scan", budgetAmount: 5, settlementAsset: "usdg" },
                status: "approved",
                agent_id: "agent-anna",
                agent_name: "Anna by LiegeAgents",
                job_id: "job-live",
                job_status: "funded",
                progress: {
                  stage: "drafting",
                  message: "Anna is working on your deliverable.",
                  percent: 40,
                  created_at: new Date().toISOString(),
                },
              },
            ],
          },
        },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/v1/me", (route) => route.fulfill({ json: { data: {} } }));

  await page.goto("/app?view=requests");
  const row = page.locator(".request-row", { hasText: "Market scan" });
  await expect(row).toContainText("› Anna is working on your deliverable.");
  await expect(row.locator(".status")).toHaveText("In progress");
  await row.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Live progress");
  await expect(dialog.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
});
