import { expect, test } from "@playwright/test";

test("watch large LIEGE transfers and see a job waiting for funding", async ({ page }) => {
  const anna = {
    id: "agent-anna",
    name: "Anna by LiegeAgents",
    price_usd: "3",
    settlement_assets: ["usdg"],
    service_settlement_assets: ["usdg"],
  };
  const token = "0xc32ab2e562ade6fba6d3d1e3960d49b0957ef645";
  const created: Record<string, unknown>[] = [];
  let triggers: Record<string, unknown>[] = [];
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [anna], proposals: [], jobs: [] } } });
    if (path.endsWith("/chain-triggers") && request.method() === "GET")
      return route.fulfill({ json: { data: triggers } });
    if (path.endsWith("/chain-triggers") && request.method() === "POST") {
      const input = request.postDataJSON();
      created.push(input);
      triggers = [
        {
          id: "chain-1",
          agent_name: anna.name,
          kind: "token_transfer",
          contract_address: token,
          event_signature: "Transfer(address indexed from, address indexed to, uint256 value)",
          token_symbol: "LIEGE",
          min_amount: "1000000",
          watch_address: null,
          settlement_asset: "usdg",
          budget_amount: "3",
          spend_cap: "15",
          committed_amount: "3",
          runs_count: 1,
          skipped_count: 2,
          cooldown_minutes: 60,
          max_runs_per_day: 4,
          auto_fund: false,
          status: "active",
          status_reason: null,
          runs: [
            {
              id: "run-1",
              tx_hash: `0x${"ab".repeat(32)}`,
              summary: "1,500,000 LIEGE moved from 0x1111…1111 to 0x2222…2222",
              outcome: "awaiting_funding",
              detail: "On-chain escrow needs your wallet. Fund this job in your dashboard.",
              job_status: "open",
              job_deadline_at: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
        },
      ];
      return route.fulfill({ status: 201, json: { data: triggers[0] } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/v1/me", (route) => route.fulfill({ json: { data: {} } }));

  await page.goto("/app?view=onchain");
  await expect(page.getByText("Nothing watched yet.")).toBeVisible();
  await expect(page.getByLabel("Agent", { exact: true })).toHaveValue(anna.id);
  await page.getByLabel("Token contract").fill(token);
  await page.getByLabel("At least (tokens, optional)").fill("1000000");
  await page.getByLabel("Total spending cap").fill("15");
  await page.getByRole("button", { name: "Approve and watch" }).click();
  expect(created[0]).toEqual({
    agentId: anna.id,
    kind: "token_transfer",
    contract: token,
    minAmount: 1000000,
    settlementAsset: "usdg",
    budgetAmount: 3,
    spendCap: 15,
    cooldownMinutes: 60,
    maxRunsPerDay: 4,
    autoFund: false,
    source: "dashboard",
  });
  await expect(page.getByRole("dialog")).toContainText("Events from before now are not counted.");
  await page.getByRole("button", { name: "Got it" }).click();
  const item = page.locator(".trigger-item");
  await expect(item).toContainText("LIEGE transfers of 1,000,000+");
  await expect(item).toContainText(
    "1,500,000 LIEGE moved from 0x1111…1111 to 0x2222…2222: Fund by",
  );
  await expect(item).toContainText("2 more events held back by your limits");
  await expect(item.getByRole("link", { name: "Transaction" })).toHaveAttribute(
    "href",
    `https://robinhoodchain.blockscout.com/tx/0x${"ab".repeat(32)}`,
  );

  // Contract events ask for the event instead of amount filters.
  await page.getByLabel("Watch for").selectOption("contract_event");
  await expect(page.getByLabel("Event", { exact: true })).toBeVisible();
  await expect(page.getByLabel("At least (tokens, optional)")).toHaveCount(0);
});
