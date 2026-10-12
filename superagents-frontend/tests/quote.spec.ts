import { expect, test } from "@playwright/test";

test("chat quotes an agent and creates the proposal at the accepted suggested budget", async ({
  page,
}) => {
  const created: Record<string, unknown>[] = [];
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/me", (route) => route.fulfill({ json: { data: {} } }));
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [], proposals: [], jobs: [] } } });
    if (path.endsWith("/intents/parse"))
      return route.fulfill({
        json: {
          data: {
            agentName: "Anna",
            request: "Market scan",
            settlementAsset: "usdg",
            budgetAmount: null,
            budgetUsdg: null,
            deadlineAt: null,
            quote: {
              agentName: "Anna by LiegeAgents",
              serviceName: "Research brief",
              slaMinutes: 60,
              deliveryBy: new Date(Date.now() + 3_600_000).toISOString(),
              suggestedBudget: 5,
              notes: [],
            },
          },
        },
      });
    if (path.endsWith("/intents") && request.method() === "POST") {
      created.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { data: { id: "intent-1" } } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app");
  const box = page.getByLabel("Ask Liege to hire an agent");
  await box.fill("Hire Anna for a market scan");
  await page.getByRole("button", { name: "Send request" }).click();
  const quote = page.locator(".chat-message.assistant").last();
  await expect(quote).toContainText("Anna by LiegeAgents · Research brief");
  await expect(quote).toContainText("about 60 minutes");
  await expect(quote).toContainText("Suggested budget: 5 USDG");
  expect(created).toEqual([]);

  await box.fill("yes");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.locator(".chat-message.assistant").last()).toContainText(
    "A proposal is waiting in Requests",
  );
  expect(created).toEqual([{ text: "Hire Anna for a market scan", budgetAmount: 5 }]);
});
