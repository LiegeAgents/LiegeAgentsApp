import { expect, test } from "@playwright/test";

test("a request that names no agent shows who Liege picked and why", async ({ page }) => {
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
            agentName: "research-brief",
            request: "Research competitors",
            settlementAsset: "usdg",
            budgetAmount: 3,
            budgetUsdg: 3,
            deadlineAt: null,
            routed: {
              agentName: "Anna by LiegeAgents",
              reason: "It asks for competitor research, which Anna's Research brief covers.",
              method: "model",
            },
            quote: {
              agentName: "Anna by LiegeAgents",
              serviceName: "Research brief",
              slaMinutes: 60,
              deliveryBy: new Date(Date.now() + 3_600_000).toISOString(),
              suggestedBudget: 3,
              notes: [],
            },
          },
        },
      });
    if (path.endsWith("/intents") && request.method() === "POST")
      return route.fulfill({ status: 201, json: { data: { id: "intent-1" } } });
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app");
  await page.getByLabel("Ask Liege to hire an agent").fill("Research our top competitors, 3 USDG");
  await page.getByRole("button", { name: "Send request" }).click();
  const reply = page.locator(".chat-message.assistant").last();
  await expect(reply).toContainText(
    "I picked Anna by LiegeAgents: It asks for competitor research",
  );
  await expect(reply).toContainText("I’d route this to Anna by LiegeAgents");
  await expect(reply).toContainText("A proposal is waiting in Requests");
});
