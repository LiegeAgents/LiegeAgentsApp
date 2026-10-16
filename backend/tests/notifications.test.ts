import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  bearer,
  clearData,
  createAgent,
  createJob,
  databaseAvailable,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";

let client: User;
let provider: User;
let agentId: string;

describe.skipIf(!databaseAvailable)("persistent notifications", () => {
  beforeAll(rebuildSchema);
  beforeEach(async () => {
    await clearData();
    [client, provider] = await Promise.all([signIn(), signIn()]);
    agentId = await createAgent(provider);
  });

  test("job events create recipient-only notifications and persist read state", async () => {
    const jobId = await createJob(client, agentId, 5);

    const providerInbox = await api().get("/v1/notifications").set(bearer(provider)).expect(200);
    expect(providerInbox.body.data.unreadCount).toBe(1);
    expect(providerInbox.body.data.items[0]).toMatchObject({
      job_id: jobId,
      event_type: "job.opened",
      title: "New job request",
      message: expect.any(String),
      read_at: null,
    });

    const clientInbox = await api().get("/v1/notifications").set(bearer(client)).expect(200);
    expect(clientInbox.body.data).toEqual({ items: [], unreadCount: 0 });

    const notificationId = providerInbox.body.data.items[0].id;
    await api().post(`/v1/notifications/${notificationId}/read`).set(bearer(client)).expect(404);
    const marked = await api()
      .post(`/v1/notifications/${notificationId}/read`)
      .set(bearer(provider))
      .expect(200);
    expect(marked.body.data.read_at).toBeTruthy();

    const afterRead = await api().get("/v1/notifications").set(bearer(provider)).expect(200);
    expect(afterRead.body.data.unreadCount).toBe(0);
    expect(afterRead.body.data.items[0].read_at).toBeTruthy();
  });

  test("mark all read only updates the authenticated user's inbox", async () => {
    await createJob(client, agentId, 5);
    const result = await api().post("/v1/notifications/read-all").set(bearer(provider)).expect(200);
    expect(result.body.data).toEqual({ markedRead: 1, unreadCount: 0 });

    const clientInbox = await api().get("/v1/notifications").set(bearer(client)).expect(200);
    expect(clientInbox.body.data.unreadCount).toBe(0);
  });
});
