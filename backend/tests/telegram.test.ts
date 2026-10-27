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
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";
import { env } from "../src/config.js";
import { createWebhookSubscription } from "../src/webhooks.js";
import { callProof } from "../src/superAgentCalls.js";
import { callTransport } from "../src/superAgentProbe.js";
import { handleUpdate, telegramTransport } from "../src/telegram.js";

const token = "0x" + "ab".repeat(20);
const TG_USER = 4242;
const CHAT = 4242;

describe.skipIf(!databaseAvailable)("Liege on Telegram", () => {
  beforeAll(rebuildSchema);
  const original = {
    token: env.TELEGRAM_BOT_TOKEN,
    secret: env.TELEGRAM_WEBHOOK_SECRET,
    name: env.TELEGRAM_BOT_USERNAME,
  };
  const spies: Array<{ mockRestore(): void }> = [];
  let client: User;
  let replies: string[];
  let calls: number;
  let update = 1;

  beforeEach(async () => {
    await clearData();
    env.TELEGRAM_BOT_TOKEN = "123:abc";
    env.TELEGRAM_WEBHOOK_SECRET = "telegram-test-secret";
    env.TELEGRAM_BOT_USERNAME = "liegeagentsbot";
    client = await signIn();
    await credit(client.userId, 10);
    replies = [];
    calls = 0;
    spies.push(
      spyOn(telegramTransport, "send").mockImplementation(async (_method, body) => {
        replies.push(String(body.text));
      }),
    );
    // Constantine selling rug checks at 0.25 USDG per instant call.
    const owner = await signIn();
    const agentId = await createAgent(owner);
    const service = (
      await api()
        .post("/v1/services")
        .set(bearer(owner))
        .send({
          agentId,
          slug: "rug-check",
          name: "Rug check",
          description: "A rug-pull risk report for one token.",
          serviceType: "skill",
          priceUsd: 2,
          slaMinutes: 30,
        })
        .expect(201)
    ).body.data;
    const hook = await createWebhookSubscription(owner.userId, agentId, "https://8.8.8.8/hook", [
      "job.funded",
    ]);
    await db.query(
      `INSERT INTO superagent_enrollments (agent_id, service_id, webhook_id, enabled, verified_at, call_price_usdg)
       VALUES ($1,$2,$3,true,now(),0.25)`,
      [agentId, service.id, hook.id],
    );
    spies.push(
      spyOn(callTransport, "send").mockImplementation(async (_url, body) => {
        calls++;
        const event = JSON.parse(body);
        const output = `# Rug check\nNo major red flags for ${token.slice(0, 6)}.`;
        return {
          status: 200,
          proof: callProof(hook.secret, event.callId, output),
          body: JSON.stringify({ data: { status: "answered", output } }),
        };
      }),
    );
  });
  afterEach(() => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    env.TELEGRAM_BOT_TOKEN = original.token;
    env.TELEGRAM_WEBHOOK_SECRET = original.secret;
    env.TELEGRAM_BOT_USERNAME = original.name;
  });

  const say = (text: string, chatType = "private", id = update++) =>
    handleUpdate({
      update_id: id,
      message: {
        text,
        chat: { id: CHAT, type: chatType },
        from: { id: TG_USER, username: "jack" },
      },
    });

  async function linked() {
    const link = (await api().post("/v1/me/telegram/link").set(bearer(client)).expect(201)).body
      .data;
    expect(link.url).toStartWith("https://t.me/liegeagentsbot?start=");
    await say(`/start ${new URL(link.url).searchParams.get("start")}`);
    expect(replies.at(-1)).toContain("Linked to your Liege workspace.");
  }

  test("the webhook takes only Telegram's secret, and is off until configured", async () => {
    await api()
      .post("/v1/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "wrong-secret-value")
      .send({ update_id: 1 })
      .expect(401);
    await api()
      .post("/v1/telegram/webhook")
      .set("x-telegram-bot-api-secret-token", "telegram-test-secret")
      .send({ update_id: 900 })
      .expect(200);
    // The update is handled after the response; let it finish before the data is cleared.
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await db.query("SELECT 1 FROM telegram_updates WHERE update_id = 900")).rowCount) break;
      await Bun.sleep(10);
    }
    env.TELEGRAM_BOT_TOKEN = undefined;
    expect(
      (await api().post("/v1/telegram/webhook").send({ update_id: 2 }).expect(503)).body.error.code,
    ).toBe("telegram_unavailable");
  });

  test("a one-time link ties the chat to the workspace", async () => {
    await say("/balance");
    expect(replies.at(-1)).toContain("Link this chat to your Liege workspace first");
    await linked();
    const status = (await api().get("/v1/me/telegram").set(bearer(client)).expect(200)).body.data;
    expect(status).toMatchObject({
      enabled: true,
      link: { username: "jack", daily_cap_usdg: "5" },
    });
    await say("/balance");
    expect(replies.at(-1)).toContain("Available: 10 USDG · 0 LIEGE");
    // A used or made-up code does nothing.
    await say("/start not-a-real-code");
    expect(replies.at(-1)).toContain("expired or was already used");
  });

  test("/rugcheck runs an instant call from the balance, once per update, under the daily cap", async () => {
    await linked();
    await say(`/rugcheck ${token}`, "private", 500);
    expect(replies.at(-1)).toContain("No major red flags");
    expect(replies.at(-1)).toContain("charged 0.25 USDG");
    expect(await availableBalance(client.userId)).toBe(9.75);
    // Telegram redelivering the same update does not run or charge again.
    await say(`/rugcheck ${token}`, "private", 500);
    expect(calls).toBe(1);

    await api().put("/v1/me/telegram").set(bearer(client)).send({ dailyCapUsdg: 0.3 }).expect(200);
    await say(`/rugcheck ${token}`);
    expect(replies.at(-1)).toContain("daily limit of 0.3 USDG");
    expect(calls).toBe(1);
    expect(await availableBalance(client.userId)).toBe(9.75);
    await say("/rugcheck SAFU?");
    expect(replies.at(-1)).toContain("Send the token's contract address");
  });

  test("/hire prepares a proposal that still needs approval, and /unlink disconnects", async () => {
    await linked();
    await say("/hire hire Research Agent to check this token, budget 3 USDG");
    expect(replies.at(-1)).toContain("is waiting for your approval");
    const intent = await db.query("SELECT source, status FROM superagent_intents");
    expect(intent.rows[0]).toMatchObject({ source: "telegram", status: "pending" });
    // Group chats are never answered.
    const before = replies.length;
    await say("/balance", "group");
    expect(replies.length).toBe(before);
    await say("/unlink");
    expect(replies.at(-1)).toContain("Disconnected");
    expect((await db.query("SELECT 1 FROM telegram_links")).rowCount).toBe(0);
  });
});
