import { expect, test, type Page } from "@playwright/test";

const constantine = {
  id: "agent-constantine",
  name: "Constantine by LiegeAgents",
  settlement_assets: ["usdg"],
  call_price_usdg: "0.250000",
  call_price_liege: null,
};
const scott = { id: "agent-scott", name: "Scott", settlement_assets: ["usdg"] };

const call = (overrides: Record<string, unknown> = {}) => ({
  id: "call-1",
  agentId: constantine.id,
  agentName: constantine.name,
  serviceSlug: "rug-check",
  settlementAsset: "usdg",
  price: "0.25",
  status: "succeeded",
  charged: true,
  role: "client",
  input: "Check 0xabc",
  output: "# Rug check\nNo major red flags.",
  error: null,
  durationMs: 4200,
  createdAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  ...overrides,
});

async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
}

test("ask an agent instantly, then see a refund when it declines", async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  let history: Record<string, unknown>[] = [];
  let decline = false;
  await signIn(page);
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({
        json: { data: { agents: [constantine, scott], proposals: [], jobs: [] } },
      });
    if (path.endsWith("/calls") && request.method() === "GET")
      return route.fulfill({ json: { data: history } });
    if (path.endsWith("/calls") && request.method() === "POST") {
      sent.push(request.postDataJSON());
      if (decline) {
        const refunded = call({
          id: "call-2",
          status: "refunded",
          charged: false,
          output: null,
          error: "The agent declined: No token address in the request.",
        });
        history = [refunded, ...history];
        return route.fulfill({
          status: 502,
          json: {
            error: {
              code: "call_failed",
              message: "The agent declined: No token address in the request. You were not charged.",
            },
            data: refunded,
          },
        });
      }
      history = [call()];
      return route.fulfill({ status: 201, json: { data: call() } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app?view=instant");
  // Only agents with a call price are offered.
  await expect(page.getByLabel("Agent").locator("option")).toHaveText([constantine.name]);
  await expect(page.locator(".instant-x402")).toContainText(`/v1/x402/calls/${constantine.id}`);
  await page.getByLabel("Request").fill("Check 0xabc");
  await page.getByRole("button", { name: "Ask · 0.25 USDG" }).click();
  await expect(page.locator(".instant-answer")).toContainText("No major red flags.");
  await expect(page.locator(".instant-answer")).toContainText("Charged 0.25 USDG");
  expect(sent[0]).toMatchObject({
    agentId: constantine.id,
    input: "Check 0xabc",
    settlementAsset: "usdg",
  });
  expect(String(sent[0].idempotencyKey)).toMatch(/^web-/);

  decline = true;
  await page.getByLabel("Request").fill("Is it safe?");
  await page.getByRole("button", { name: "Ask · 0.25 USDG" }).click();
  await expect(page.getByRole("dialog")).toContainText("You were not charged.");
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.locator(".instant-answer")).toContainText("Refunded, not charged");
  await expect(page.locator(".recurring-item", { hasText: "Refunded" }).last()).toBeVisible();
});
