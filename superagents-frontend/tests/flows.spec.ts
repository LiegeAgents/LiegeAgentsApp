import { expect, test } from "@playwright/test";

test("chat ignores greetings, refreshes proposals, and opens a real agent safely", async ({
  page,
}) => {
  const errors: string[] = [];
  let creations = 0;
  const proposals: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/dashboard")) return route.fulfill({ json: { data: { proposals } } });
    if (path.endsWith("/intents/parse")) {
      const greeting = route.request().postDataJSON().text === "Hey";
      return route.fulfill({
        json: {
          data: {
            agentName: greeting ? null : "Anna by LiegeAgents",
            budgetUsdg: greeting ? null : 5,
          },
        },
      });
    }
    if (path.endsWith("/intents")) {
      creations++;
      proposals.push({
        id: "420f45cf-bc07-43cc-837f-dd05755598fb",
        agent_id: "real-anna-id",
        agent_name: "Anna by LiegeAgents",
        parsed: { request: "Research agent marketplaces", budgetUsdg: 5 },
        status: "pending",
      });
      return route.fulfill({ status: 201, json: { data: proposals[0] } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/app");
  const input = page.getByRole("textbox", { name: "Ask Liege to hire an agent" });
  await input.fill("Hey");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Tell me who you’d like to hire", { exact: false })).toBeVisible();
  expect(creations).toBe(0);
  await input.fill("Hire Anna by LiegeAgents to research agent marketplaces. Budget 5 USDG");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.locator(".sidebar nav b")).toHaveText("1");
  await page.goto("/app?view=requests");
  await page.getByRole("button", { name: /Research agent marketplaces/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Anna by LiegeAgents");
  expect(errors).toEqual([]);
  expect(creations).toBe(1);
});

test("landing renders the flagship team and accessible details without overflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A little mention. A lot of possibility." }),
  ).toBeVisible();
  await page.locator(".agent-card").filter({ hasText: "Scott" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Scott by LiegeAgents" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("four steps require preview consent and lead to a clearly labeled dashboard", async ({
  page,
}) => {
  await page.goto("/auth?agent=anna&preview=1");
  await page.getByRole("button", { name: "Preview X connection" }).click();
  await page.getByRole("button", { name: "Preview wallet connection" }).click();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Open preview dashboard" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.locator(".demo-banner")).toContainText("sample data");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("approve a sample request, persist it, filter it, and retain the no-funding boundary", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4174")) externalRequests.push(r.url());
  });
  await page.goto("/app?view=requests");
  await page.evaluate(() => {
    sessionStorage.setItem(
      "liege-superagents-workspace-v1",
      JSON.stringify({
        onboarded: true,
        requests: [
          {
            id: "sample-request",
            title: "A launch story worth sharing",
            agentId: "scott",
            budget: "5",
            asset: "USDG",
            status: "Needs review",
            source: "@LiegeAgentsBot hire Scott to write a launch story.",
            brief: "Write a launch story.",
            due: "To be scheduled",
          },
        ],
        activity: [],
        drafts: [],
      }),
    );
  });
  await page.reload();
  await page.getByRole("button", { name: /A launch story worth sharing/ }).click();
  await page.getByRole("button", { name: "Approve proposal" }).click();
  await expect(page.getByRole("dialog")).toContainText(/no funds moved/i);
  await page.getByRole("button", { name: "Got it" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Approved draft", exact: true }).click();
  await expect(page.locator(".request-row")).toHaveCount(1);
  await page.getByRole("textbox", { name: "Search requests" }).fill("not found");
  await expect(page.getByText("No requests here.")).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("agent draft and settings reset work on direct routes", async ({ page }) => {
  await page.goto("/app?view=agents");
  await page.getByRole("button", { name: "Create an agent draft", exact: true }).first().click();
  await page.getByLabel("Agent name").fill("Maya Research");
  await page
    .getByLabel("What does your agent offer?")
    .fill("Cited protocol research and competitor comparisons.");
  await page.getByRole("button", { name: "Save preview draft" }).click();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.locator(".draft-row")).toContainText("Maya Research");
  await page.goto("/app?view=settings");
  await expect(page.getByRole("heading", { name: "Connected identities" })).toBeVisible();
  await page.getByRole("button", { name: "Reset preview connections" }).click();
  await page.getByRole("button", { name: "Reset preview", exact: true }).click();
  await expect(page).toHaveURL(/\/auth$/);
  expect(
    await page.evaluate(() => sessionStorage.getItem("liege-superagents-preview-v1")),
  ).toBeNull();
});
