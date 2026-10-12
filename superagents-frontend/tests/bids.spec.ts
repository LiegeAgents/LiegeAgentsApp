import { expect, test } from "@playwright/test";

test("agents bid on a request and the client hires one", async ({ page }) => {
  let auctions: Record<string, unknown>[] = [];
  const posted: Record<string, unknown>[] = [];
  const awarded: Record<string, unknown>[] = [];
  const bid = (id: string, agentName: string, extra: Record<string, unknown>) => ({
    id,
    agentName,
    status: "submitted",
    price: null,
    deliveryMinutes: null,
    approach: null,
    listedPriceUsd: 5,
    ...extra,
  });
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [], proposals: [], jobs: [] } } });
    if (path.endsWith("/auctions") && request.method() === "GET")
      return route.fulfill({ json: { data: auctions } });
    if (path.endsWith("/auctions") && request.method() === "POST") {
      posted.push(request.postDataJSON());
      auctions = [
        {
          id: "auction-1",
          request: posted[0].request,
          settlementAsset: "usdg",
          maxBudget: 8,
          closesAt: new Date(Date.now() + 120_000).toISOString(),
          phase: "bidding",
          jobId: null,
          bids: [
            bid("bid-anna", "Anna", {
              price: 6,
              deliveryMinutes: 45,
              approach: "Five competitors, a pricing table, cited sources.",
            }),
            bid("bid-scott", "Scott", { status: "invited" }),
            bid("bid-marcus", "Marcus", { status: "declined" }),
          ],
        },
      ];
      return route.fulfill({ status: 201, json: { data: auctions[0] } });
    }
    if (path.endsWith("/auction-1/award")) {
      awarded.push(request.postDataJSON());
      const current = auctions[0] as { bids: Record<string, unknown>[] };
      auctions = [
        {
          ...auctions[0],
          phase: "awarded",
          bids: current.bids.map((item) =>
            item.id === "bid-anna"
              ? { ...item, status: "won" }
              : { ...item, status: item.status === "declined" ? "declined" : "lost" },
          ),
        },
      ];
      return route.fulfill({
        json: { data: { auction: auctions[0], job: { id: "job-1", status: "funded" } } },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app?view=bids");
  await expect(page.getByRole("heading", { name: "No bids yet." })).toBeVisible();
  await page.getByLabel("What do you need?").fill("A competitor scan for Notely.");
  await page.getByLabel("Maximum budget (optional)").fill("8");
  await page.getByLabel("Bidding time").selectOption("2");
  await page.getByRole("button", { name: "Ask agents to bid" }).click();
  await expect(page.getByRole("dialog")).toContainText("Agents are bidding");
  await page.getByRole("button", { name: "Got it" }).click();
  expect(posted).toEqual([
    {
      request: "A competitor scan for Notely.",
      settlementAsset: "usdg",
      biddingMinutes: 2,
      maxBudget: 8,
      source: "dashboard",
    },
  ]);

  await expect(page.locator(".bid-countdown")).toBeVisible();
  await expect(page.locator(".bid-card").first()).toContainText("6 USDG · 45 min");
  await expect(page.locator(".bid-card").nth(1)).toContainText("Thinking…");
  await expect(page.locator(".bid-card").nth(2)).toContainText("Passed");
  await page.getByRole("button", { name: "Hire for 6 USDG" }).click();
  await expect(page.getByRole("dialog")).toContainText("Anna hired");
  expect(awarded).toEqual([{ bidId: "bid-anna", fund: true }]);
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.locator(".auction-item .status")).toHaveText("Hired");
  await expect(page.locator(".bid-won")).toContainText("Hired");
});
