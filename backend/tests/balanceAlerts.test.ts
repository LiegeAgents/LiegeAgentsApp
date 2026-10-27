import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  db,
  openJob,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";
import { env } from "../src/config.js";
import { pushBalanceAlerts, telegramTransport } from "../src/telegram.js";

describe.skipIf(!databaseAvailable)("low-balance alerts", () => {
  beforeAll(rebuildSchema);
  let client: User;
  let agentId: string;
  beforeEach(async () => {
    await clearData();
    const provider = await signIn();
    client = await signIn();
    agentId = await createAgent(provider);
    await credit(client.userId, 10);
  });

  async function spend(amount: number) {
    const jobId = (await openJob(client, agentId, amount).expect(201)).body.data.id;
    await api().post(`/v1/jobs/${jobId}/fund`).set(bearer(client)).send({}).expect(200);
  }
  const inbox = async () =>
    (await api().get("/v1/notifications").set(bearer(client)).expect(200)).body.data.items.filter(
      (item: { event_type: string }) => item.event_type === "balance.low",
    );
  const setAlert = (threshold: number, asset = "usdg") =>
    api().put(`/v1/me/balance-alerts/${asset}`).set(bearer(client)).send({ threshold });

  test("alerts once when a debit crosses the level, and again after a top-up", async () => {
    const saved = (await setAlert(5).expect(200)).body.data;
    expect(saved).toMatchObject({ asset: "usdg", threshold: "5", below: false });

    await spend(3); // 10 → 7
    expect(await inbox()).toHaveLength(0);
    await spend(3); // 7 → 4: crosses 5
    const [alert] = await inbox();
    expect(alert.job_id).toBeNull();
    expect(alert.title).toBe("Low balance");
    expect(alert.message).toContain("Your available USDG is 4, below the 5 alert");
    await spend(2); // 4 → 2: already below, no repeat
    expect(await inbox()).toHaveLength(1);

    await credit(client.userId, 8); // back to 10
    await spend(6); // 10 → 4: crosses again
    expect(await inbox()).toHaveLength(2);
    expect(await availableBalance(client.userId)).toBe(4);

    const listed = (await api().get("/v1/me/balance-alerts").set(bearer(client)).expect(200)).body
      .data;
    expect(listed).toHaveLength(1);
    expect(listed[0].triggered_at).not.toBeNull();
  });

  test("a debit that lands exactly on the level does not alert", async () => {
    await setAlert(5).expect(200);
    await spend(5); // 10 → 5
    expect(await inbox()).toHaveLength(0);
    await spend(1); // 5 → 4
    expect(await inbox()).toHaveLength(1);
  });

  test("setting a level above the balance says so, and turning it off stops alerts", async () => {
    expect((await setAlert(20).expect(200)).body.data.below).toBe(true);
    await setAlert(8).expect(200);
    await api().delete("/v1/me/balance-alerts/usdg").set(bearer(client)).expect(200);
    await spend(5);
    expect(await inbox()).toHaveLength(0);
    await setAlert(0).expect(400);
    await setAlert(5, "eth").expect(400);
    // Another workspace's alert never fires on this one's balance.
    const other = await signIn();
    await api()
      .put("/v1/me/balance-alerts/usdg")
      .set(bearer(other))
      .send({ threshold: 100 })
      .expect(200);
    await spend(1);
    expect(await inbox()).toHaveLength(0);
  });

  describe("on Telegram", () => {
    const original = {
      token: env.TELEGRAM_BOT_TOKEN,
      secret: env.TELEGRAM_WEBHOOK_SECRET,
      name: env.TELEGRAM_BOT_USERNAME,
    };
    let sent: Array<{ chat_id: unknown; text: string }>;
    let spy: { mockRestore(): void };
    beforeEach(() => {
      env.TELEGRAM_BOT_TOKEN = "123:abc";
      env.TELEGRAM_WEBHOOK_SECRET = "telegram-test-secret";
      env.TELEGRAM_BOT_USERNAME = "liegeagentsbot";
      sent = [];
      spy = spyOn(telegramTransport, "send").mockImplementation(async (_method, body) => {
        sent.push({ chat_id: body.chat_id, text: String(body.text) });
      });
    });
    afterEach(() => {
      spy.mockRestore();
      env.TELEGRAM_BOT_TOKEN = original.token;
      env.TELEGRAM_WEBHOOK_SECRET = original.secret;
      env.TELEGRAM_BOT_USERNAME = original.name;
    });

    test("a fired alert goes to the linked chat once", async () => {
      await db.query(
        "INSERT INTO telegram_links (user_id, telegram_user_id, chat_id) VALUES ($1, 77, 77)",
        [client.userId],
      );
      await setAlert(5).expect(200);
      expect(await pushBalanceAlerts()).toBe(0);
      await spend(6);
      expect(await pushBalanceAlerts()).toBe(1);
      expect(sent).toEqual([
        {
          chat_id: 77,
          text: expect.stringContaining("Your available USDG on Liege fell below the 5 alert"),
        },
      ]);
      expect(await pushBalanceAlerts()).toBe(0);
      expect(sent).toHaveLength(1);
    });

    test("without a linked chat, nothing is sent", async () => {
      await setAlert(5).expect(200);
      await spend(6);
      expect(await pushBalanceAlerts()).toBe(0);
      expect(sent).toHaveLength(0);
      expect(await inbox()).toHaveLength(1);
    });
  });
});
