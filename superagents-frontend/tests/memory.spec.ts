import { expect, test } from "@playwright/test";

test("see, edit, turn off, and clear what an agent remembers", async ({ page }) => {
  const sent: Array<{ method: string; body: unknown }> = [];
  let memory = {
    agentId: "agent-anna",
    agentName: "Anna by LiegeAgents",
    enabled: true,
    preferences: "Bullet points.",
    learned: [
      {
        jobTitle: "Market scan",
        feedback: "Add a summary at the top.",
        at: new Date().toISOString(),
      },
    ],
  };
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [], proposals: [], jobs: [] } } });
    if (path.endsWith("/memory")) return route.fulfill({ json: { data: [memory] } });
    if (path.endsWith("/memory/agent-anna")) {
      const body = request.postDataJSON?.() ?? null;
      sent.push({ method: request.method(), body });
      if (request.method() === "DELETE") memory = { ...memory, preferences: null, learned: [] };
      else memory = { ...memory, ...(body ?? {}) };
      return route.fulfill({ json: { data: memory } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  await page.goto("/app?view=memory");
  const item = page.locator(".memory-item");
  await expect(item).toContainText("Anna by LiegeAgents");
  await expect(item).toContainText("Add a summary at the top.");
  await item.getByLabel("Your preferences").fill("Bullet points, cite sources.");
  await item.getByRole("button", { name: "Save preferences" }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toEqual({ method: "PUT", body: { preferences: "Bullet points, cite sources." } });

  await item.getByRole("button", { name: "Clear memory" }).click();
  await expect(item).not.toContainText("Add a summary at the top.");
  // The box follows the saved state, so it changes once the server answers.
  await item.getByLabel("Remember me").click();
  await expect(item.getByLabel("Remember me")).not.toBeChecked();
  await expect.poll(() => sent.at(-1)).toEqual({ method: "PUT", body: { enabled: false } });
  await expect(item.getByLabel("Your preferences")).toHaveCount(0);
});
