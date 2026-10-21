import { expect, test, type Page } from "@playwright/test";

const key = (overrides: Record<string, unknown> = {}) => ({
  id: "key-1",
  name: "Research bot",
  max_budget_per_hire: "5",
  daily_budget: "20",
  proposed_today: "4",
  expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  revoked_at: null,
  last_used_at: null,
  created_at: new Date().toISOString(),
  ...overrides,
});

async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
}

test("create a hiring key, copy its configuration once, and revoke it", async ({ page }) => {
  const sent: Record<string, unknown>[] = [];
  let keys: Record<string, unknown>[] = [];
  await signIn(page);
  await page.route("**/v1/super-agents/**", (route) =>
    route.fulfill({ json: { data: { agents: [], proposals: [], jobs: [] } } }),
  );
  await page.route("**/v1/mcp/hire-keys**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { data: keys } });
    if (request.method() === "POST") {
      sent.push(request.postDataJSON());
      keys = [key()];
      return route.fulfill({
        status: 201,
        json: {
          data: {
            id: "key-1",
            token: "lmh_secret",
            expiresAt: keys[0].expires_at,
            presets: {
              claude_desktop: {
                name: "Claude Desktop",
                filename: "claude_desktop_config.json",
                config: {
                  mcpServers: {
                    "liege-hire": { headers: { Authorization: "Bearer lmh_secret" } },
                  },
                },
              },
            },
          },
        },
      });
    }
    keys = [key({ revoked_at: new Date().toISOString() })];
    return route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/app?view=hire-keys");
  await expect(page.getByText("No hiring keys yet.")).toBeVisible();
  await page.getByLabel("Name").fill("Research bot");
  await page.getByLabel("Most per hire (USDG)").fill("5");
  await page.getByLabel("Daily budget (USDG)").fill("20");
  await page.getByRole("button", { name: "Create key" }).click();
  expect(sent[0]).toEqual({ name: "Research bot", maxBudgetPerHire: 5, dailyBudget: 20 });
  await expect(page.locator(".hire-key-created")).toContainText("It is shown once.");
  await expect(page.locator(".hire-key-created pre")).toContainText("Bearer lmh_secret");
  await expect(page.locator(".recurring-item", { hasText: "Research bot" })).toContainText(
    "4 of 20 USDG proposed today",
  );

  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("dialog")).toContainText("can no longer propose work");
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.locator(".hire-key-created")).toHaveCount(0);
  await expect(page.locator(".watch-tag", { hasText: "Revoked" })).toBeVisible();
});

test("a proposal from a hiring key is labelled in Requests", async ({ page }) => {
  await signIn(page);
  await page.route("**/v1/super-agents/**", (route) =>
    route.fulfill({
      json: {
        data: {
          agents: [{ id: "agent-scott", name: "Scott", settlement_assets: ["usdg"] }],
          jobs: [],
          proposals: [
            {
              id: "intent-1",
              raw_text: "Hire Scott to summarize this week's chain news",
              parsed: {
                request: "Summarize this week's chain news",
                budgetAmount: 3,
                settlementAsset: "usdg",
              },
              negotiation: [],
              status: "pending",
              source: "mcp",
              hire_key_name: "Research bot",
              agent_id: "agent-scott",
              agent_name: "Scott",
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              created_at: new Date().toISOString(),
            },
          ],
        },
      },
    }),
  );
  await page.route("**/v1/me", (route) => route.fulfill({ json: { data: {} } }));
  await page.goto("/app?view=requests");
  const row = page.locator(".request-row", { hasText: "Summarize this week's chain news" });
  await expect(row).toContainText("via Research bot");
  await row.click();
  await expect(
    page.getByText("Proposed by your AI agent with the hiring key “Research bot”."),
  ).toBeVisible();
});
