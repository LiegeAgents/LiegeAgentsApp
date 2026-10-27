import { createHash, randomBytes } from "node:crypto";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";
import { userBalance } from "./ledger.js";
import { readyEnrollment } from "./superAgentEnrollment.js";
import { presentCall, runCall } from "./superAgentCalls.js";
import { createIntent } from "./routes/superAgents.js";

/**
 * Liege on Telegram. A workspace links one Telegram account with a one-time code (a t.me deep
 * link), and the bot then answers in that private chat: /rugcheck runs a rug check as an instant
 * call paid from the Liege balance under the link's daily cap, /hire prepares a proposal that
 * still waits for approval in the dashboard, and /balance shows what is available. Replies are
 * plain text, so nothing a user or agent writes is rendered as markup.
 */
export const telegramEnabled = () =>
  Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && env.TELEGRAM_BOT_USERNAME);

/** The Bot API call; tests replace `send`. */
export const telegramTransport = {
  async send(method: string, body: Record<string, unknown>) {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw new Error(`Telegram ${method} returned HTTP ${response.status}.`);
  },
};

const LIMIT = 4_000;
const reply = (chatId: number, text: string) =>
  telegramTransport.send("sendMessage", {
    chat_id: chatId,
    text:
      text.length > LIMIT
        ? `${text.slice(0, LIMIT - 40)}\n\n[Full answer in your workspace.]`
        : text,
    disable_web_page_preview: true,
  });

const hashCode = (code: string) => createHash("sha256").update(code).digest("hex");

/** A one-time link that ties the opener's Telegram account to this workspace, for 10 minutes. */
export async function createLinkCode(userId: string) {
  if (!telegramEnabled())
    throw new ApiError(503, "telegram_unavailable", "Telegram is not set up yet.");
  const code = randomBytes(24).toString("base64url");
  await db.query(
    "INSERT INTO telegram_link_codes (code_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '10 minutes')",
    [hashCode(code), userId],
  );
  return { url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${code}`, expiresInMinutes: 10 };
}

const HELP = `Liege on Telegram
/rugcheck <token address> [chain] - a rug-pull risk check, paid from your Liege balance
/hire <what you need> - a proposal for the best-fitting Super Agent; approve it in your workspace
/balance - your available Liege balance
/unlink - disconnect this Telegram account`;

type Update = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
  };
};

async function linkedUser(telegramUserId: number) {
  const found = await db.query<{ user_id: string; daily_cap_usdg: string }>(
    "SELECT user_id, daily_cap_usdg::text FROM telegram_links WHERE telegram_user_id = $1",
    [telegramUserId],
  );
  return found.rows[0] ?? null;
}

async function rugCheckAgent() {
  const found = await db.query<{ id: string; name: string; price: string }>(
    `SELECT a.id, a.name, trim_scale(e.call_price_usdg)::text AS price FROM agents a ${readyEnrollment}
     WHERE a.active AND e.enabled AND e.verified_at IS NOT NULL AND s.slug = 'rug-check'
       AND e.call_price_usdg IS NOT NULL AND 'usdg' = ANY(e.settlement_assets)
     ORDER BY e.call_price_usdg, a.created_at LIMIT 1`,
  );
  return found.rows[0] ?? null;
}

async function link(chatId: number, from: { id: number; username?: string }, code: string) {
  const claimed = await db.query<{ user_id: string }>(
    `UPDATE telegram_link_codes SET used_at = now()
     WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [hashCode(code)],
  );
  if (!claimed.rowCount)
    return reply(
      chatId,
      "That link has expired or was already used. Open a new one from your workspace Settings.",
    );
  const elsewhere = await linkedUser(from.id);
  if (elsewhere && elsewhere.user_id !== claimed.rows[0].user_id)
    return reply(
      chatId,
      "This Telegram account is linked to another Liege workspace. Send /unlink there first.",
    );
  await db.query(
    `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, username) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET telegram_user_id = EXCLUDED.telegram_user_id,
       chat_id = EXCLUDED.chat_id, username = EXCLUDED.username, linked_at = now()`,
    [claimed.rows[0].user_id, from.id, chatId, from.username ?? null],
  );
  return reply(chatId, `Linked to your Liege workspace.\n\n${HELP}`);
}

async function rugCheck(
  chatId: number,
  user: { user_id: string; daily_cap_usdg: string },
  args: string,
  updateId: number,
) {
  if (!/0x[0-9a-fA-F]{40}/.test(args))
    return reply(
      chatId,
      "Send the token's contract address: /rugcheck 0x… (add a chain such as base if it is not on Robinhood Chain).",
    );
  const agent = await rugCheckAgent();
  if (!agent) return reply(chatId, "No rug-check agent is taking instant calls right now.");
  try {
    const { row } = await runCall({
      clientId: user.user_id,
      agentId: agent.id,
      request: `Rug check ${args}`,
      asset: "usdg",
      idempotencyKey: `tg-${updateId}`,
      source: "telegram",
      dailyCapUsdg: Number(user.daily_cap_usdg),
    });
    const call = presentCall(row, user.user_id);
    if (call.status !== "succeeded")
      return reply(chatId, `${call.error ?? "The check failed."} You were not charged.`);
    return reply(chatId, `${call.output}\n\n${agent.name} · charged ${call.price} USDG`);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "insufficient_credits")
        return reply(
          chatId,
          `A rug check costs ${agent.price} USDG and your balance is short. Top up in your workspace Settings.`,
        );
      return reply(chatId, error.message);
    }
    throw error;
  }
}

async function hire(chatId: number, userId: string, text: string) {
  if (text.length < 10)
    return reply(
      chatId,
      "Describe the work, with a budget: /hire research our top competitors, 5 USDG",
    );
  try {
    const intent = await createIntent(userId, undefined, {
      text,
      source: "telegram",
      suggestBudget: true,
    });
    const budget = intent.parsed.budgetAmount ?? intent.parsed.budgetUsdg;
    return reply(
      chatId,
      `${intent.routed ? `I picked ${intent.routed.agentName}: ${intent.routed.reason}\n\n` : ""}A proposal for ${intent.agent.name}${budget ? ` at ${budget} ${String(intent.parsed.settlementAsset).toUpperCase()}` : ""} is waiting for your approval. Nothing is paid until you approve it:\n${env.SUPERAGENTS_URL}/app?view=requests`,
    );
  } catch (error) {
    if (error instanceof ApiError) return reply(chatId, error.message);
    throw error;
  }
}

/** Handles one webhook update, once. Only private chats are answered. */
export async function handleUpdate(update: Update) {
  const fresh = await db.query(
    "INSERT INTO telegram_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id",
    [update.update_id],
  );
  if (!fresh.rowCount) return;
  const message = update.message;
  if (!message?.text || !message.from || message.chat.type !== "private") return;
  const chatId = message.chat.id;
  const [rawCommand, ...rest] = message.text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase().replace(/@.*$/, "");
  const args = rest.join(" ").trim();
  if (command === "/start" && args) return link(chatId, message.from, args);
  const user = await linkedUser(message.from.id);
  if (!user)
    return reply(
      chatId,
      "Link this chat to your Liege workspace first: open Settings in your workspace and choose Link Telegram.",
    );
  switch (command) {
    case "/rugcheck":
      return rugCheck(chatId, user, args, update.update_id);
    case "/hire":
      return hire(chatId, user.user_id, args);
    case "/balance": {
      const client = await db.connect();
      try {
        const [usdg, liege] = await Promise.all([
          userBalance(client, user.user_id, "available", "usdg"),
          userBalance(client, user.user_id, "available", "liege"),
        ]);
        return reply(
          chatId,
          `Available: ${usdg.amount} USDG · ${liege.amount} LIEGE\nTelegram calls are capped at ${Number(user.daily_cap_usdg)} USDG a day.`,
        );
      } finally {
        client.release();
      }
    }
    case "/unlink":
      await db.query("DELETE FROM telegram_links WHERE user_id = $1", [user.user_id]);
      return reply(chatId, "Disconnected. This chat can no longer spend from your Liege balance.");
    default:
      return reply(chatId, HELP);
  }
}

/**
 * Sends each low-balance alert that fired in the last hour to the workspace's linked chat, once.
 * The alert is claimed before the message goes out, so a failed send is not retried.
 */
export async function pushBalanceAlerts() {
  if (!telegramEnabled()) return 0;
  const due = await db.query<{ asset: string; threshold: string; chat_id: string }>(
    `UPDATE balance_alerts b SET pushed_at = now() FROM telegram_links l
     WHERE l.user_id = b.user_id AND b.triggered_at > now() - interval '1 hour'
       AND b.triggered_at > COALESCE(b.pushed_at, '-infinity')
     RETURNING b.asset, trim_scale(b.threshold)::text AS threshold, l.chat_id::text`,
  );
  for (const alert of due.rows)
    await reply(
      Number(alert.chat_id),
      `Your available ${alert.asset.toUpperCase()} on Liege fell below the ${alert.threshold} alert you set. Top up in your workspace Settings; /balance shows what is left.`,
    ).catch((error) =>
      console.error(
        JSON.stringify({
          event: "telegram.balance_alert_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  return due.rowCount ?? 0;
}

let alertTimer: ReturnType<typeof setInterval> | undefined;
export function startBalanceAlertPush() {
  if (alertTimer || env.NODE_ENV === "test") return;
  alertTimer = setInterval(() => {
    void pushBalanceAlerts().catch((error) =>
      console.error(
        JSON.stringify({
          event: "telegram.balance_alerts_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }, 30_000);
  alertTimer.unref();
}
export function stopBalanceAlertPush() {
  if (alertTimer) clearInterval(alertTimer);
  alertTimer = undefined;
}
