import { expect, test } from "@playwright/test";

test("owner saves, verifies, enables and disables an existing agent", async ({ page }) => {
  const agent = {
    id: "owned-agent",
    name: "Anna by LiegeAgents",
    active: true,
    service_id: null as string | null,
    webhook_id: null as string | null,
    enabled: false,
    verified_at: null as string | null,
  };
  await page.addInitScript(() => localStorage.setItem("liege-session-token", "test-session"));
  await page.route("**/v1/super-agents/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/dashboard"))
      return route.fulfill({ json: { data: { agents: [], proposals: [] } } });
    if (path.endsWith("/enrollments") && route.request().method() === "GET")
      return route.fulfill({
        json: {
          data: {
            agents: [agent],
            services: [
              {
                id: "service",
                agent_id: agent.id,
                name: "Research brief",
                price_usd: "5",
                sla_minutes: 60,
              },
            ],
            webhooks: [
              { id: "hook", agent_id: agent.id, url: "https://runtime.example/webhooks/anna" },
            ],
          },
        },
      });
    if (path.endsWith("/enrollments")) {
      const input = route.request().postDataJSON();
      expect(input.agentId).toBe(agent.id);
      agent.service_id = input.serviceId;
      agent.webhook_id = input.webhookId;
    } else if (path.endsWith("/verify")) {
      agent.verified_at = new Date().toISOString();
    } else if (path.endsWith("/discovery")) {
      expect(agent.verified_at).not.toBeNull();
      agent.enabled = route.request().postDataJSON().enabled;
    } else return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: { data: agent } });
  });
  await page.goto("/app?view=agents");
  await page.getByLabel("Choose your agent").selectOption(agent.id);
  await expect(page.getByRole("button", { name: "Enable discovery", exact: true })).toBeDisabled();
  await page.getByLabel("Service", { exact: true }).selectOption("service");
  await page.getByLabel("Execution webhook", { exact: true }).selectOption("hook");
  await page.getByRole("button", { name: "Save enrollment" }).click();
  await expect(page.getByRole("dialog")).toContainText("Enrollment saved");
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByRole("dialog")).toContainText("Connection verified");
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Enable discovery", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Discovery enabled");
  await page.getByRole("button", { name: "Got it" }).click();
  await page.getByRole("button", { name: "Disable discovery", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Discovery disabled");
});
