import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db/index.js";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  credit,
  databaseAvailable,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

describe.skipIf(!databaseAvailable)("notification preferences", () => {
  let client: User;
  let provider: User;
  let agentId: string;

  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    [client, provider] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(provider);
    await credit(client.userId, 50);
  });

  const inbox = async (user: User) =>
    (await api().get("/v1/notifications").set(bearer(user)).expect(200)).body.data;
  const mute = (user: User, muted: string[]) =>
    api().put("/v1/notifications/preferences").set(bearer(user)).send({ muted });

  test("a muted category is never delivered, and unmuting brings it back", async () => {
    const initial = (
      await api().get("/v1/notifications/preferences").set(bearer(provider)).expect(200)
    ).body.data;
    expect(initial.map((p: { category: string }) => p.category)).toEqual([
      "jobs",
      "feedback",
      "plans",
      "automations",
    ]);
    expect(initial.every((p: { muted: boolean }) => !p.muted)).toBe(true);

    const saved = (await mute(provider, ["jobs", "automations"]).expect(200)).body.data;
    expect(
      saved.filter((p: { muted: boolean }) => p.muted).map((p: { category: string }) => p.category),
    ).toEqual(["jobs", "automations"]);

    const first = await createJob(client, agentId, 10);
    await api().post(`/v1/jobs/${first}/fund`).set(bearer(client)).send({}).expect(200);
    expect(await inbox(provider)).toMatchObject({ items: [], unreadCount: 0 });

    // Alerts outside any category always arrive.
    await db.query(
      "INSERT INTO notifications (user_id, event_type, title, message) VALUES ($1, 'balance.low', 'Low balance', 'Top up.')",
      [provider.userId],
    );
    expect((await inbox(provider)).items.map((n: { event_type: string }) => n.event_type)).toEqual([
      "balance.low",
    ]);

    await mute(provider, []).expect(200);
    await createJob(client, agentId, 10);
    const after = await inbox(provider);
    expect(after.items.map((n: { event_type: string }) => n.event_type)).toContain("job.opened");
    expect(after.unreadCount).toBe(2);
  });

  test("unknown categories are refused and mutes are per account", async () => {
    await mute(provider, ["disputes"]).expect(400);
    await mute(client, ["jobs"]).expect(200);
    await createJob(client, agentId, 10);
    expect((await inbox(provider)).items.map((n: { event_type: string }) => n.event_type)).toEqual([
      "job.opened",
    ]);
  });
});
