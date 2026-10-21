import { expect, test } from "@playwright/test";

const intentId = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

test("a pending proposal can be countered and shows the agent's answer", async ({ page }) => {
  const counters: unknown[] = [];
  let rounds = 0;
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
                id: intentId,
                raw_text: "Hire Anna for a market scan, budget 5 USDG",
                parsed: { request: "Market scan", budgetAmount: 5, settlementAsset: "usdg" },
                negotiation: [],
                status: "pending",
                agent_id: "agent-anna",
                agent_name: "Anna by LiegeAgents",
                expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              },
            ],
          },
        },
      });
    if (path.endsWith(`/intents/${intentId}/counter`)) {
      const body = route.request().postDataJSON();
      counters.push(body);
      rounds += 1;
      const agreed = body.budgetAmount >= 4 ? body.budgetAmount : 4;
      return route.fulfill({
        json: {
          data: {
            id: intentId,
            parsed: { budgetAmount: agreed },
            negotiation: Array.from({ length: rounds }, () => ({})),
            round: {
              offer: body.budgetAmount,
              outcome: agreed === body.budgetAmount ? "accepted" : "countered",
              agreed,
            },
            message:
              agreed === body.budgetAmount
                ? `Anna by LiegeAgents accepts ${agreed} USDG. Approve the proposal to open the job.`
                : `Anna by LiegeAgents can do it for ${agreed} USDG. Approve at that price, or counter once more.`,
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/v1/me", (route) => route.fulfill({ json: { data: {} } }));

  await page.goto("/app?view=requests");
  await page.locator(".request-row", { hasText: "Market scan" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("The agent answers at once");

  await dialog.getByLabel("Counter-offer").fill("3");
  await dialog.getByRole("button", { name: "Counter" }).click();
  await expect(dialog).toContainText("Anna by LiegeAgents can do it for 4 USDG.");
  await expect(dialog.locator(".review-terms")).toContainText("4 USDG");

  await dialog.getByLabel("Counter-offer").fill("4.5");
  await dialog.getByRole("button", { name: "Counter" }).click();
  await expect(dialog).toContainText("accepts 4.5 USDG");
  await expect(dialog.getByRole("button", { name: "Counter" })).toBeDisabled();
  expect(counters).toEqual([{ budgetAmount: 3 }, { budgetAmount: 4.5 }]);
});
