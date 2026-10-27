import { env } from "./config.js";

/**
 * Points the Telegram bot at this API: `bun run telegram:webhook`. Telegram then sends every
 * message to POST /v1/telegram/webhook with TELEGRAM_WEBHOOK_SECRET in a header.
 */
if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET)
  throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first.");
const url = `${env.PUBLIC_API_URL.replace(/\/$/, "")}/v1/telegram/webhook`;
const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  }),
});
const body = (await response.json()) as { ok: boolean; description?: string };
if (!body.ok)
  throw new Error(`Telegram refused the webhook: ${body.description ?? response.status}`);
console.log(`Telegram now sends updates to ${url}.`);
