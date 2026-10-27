import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { createLinkCode, handleUpdate, telegramEnabled } from "../telegram.js";

/** Telegram's webhook. Only deliveries carrying the secret set with setWebhook are accepted. */
export const telegramRouter = Router();

const secretMatches = (given: string | undefined) => {
  const expected = Buffer.from(env.TELEGRAM_WEBHOOK_SECRET ?? "");
  const actual = Buffer.from(given ?? "");
  return (
    expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected)
  );
};

telegramRouter.post(
  "/webhook",
  asyncRoute(async (request, response) => {
    if (!telegramEnabled())
      throw new ApiError(503, "telegram_unavailable", "Telegram is not set up yet.");
    if (!secretMatches(request.header("x-telegram-bot-api-secret-token")))
      throw new ApiError(401, "invalid_telegram_secret", "Unknown webhook sender.");
    const update = z
      .object({ update_id: z.number().int() })
      .passthrough()
      .parse(request.body) as Parameters<typeof handleUpdate>[0];
    // Answer at once so a long rug check does not make Telegram redeliver; each update is handled
    // once either way.
    response.json({ ok: true });
    await handleUpdate(update).catch((error) =>
      console.error(
        JSON.stringify({
          event: "telegram.update_failed",
          updateId: update.update_id,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }),
);

/** Linking from the workspace: status, a one-time link, the daily cap, and disconnecting. */
export function registerTelegramAccountRoutes(router: Router) {
  router.get(
    "/me/telegram",
    requireAuth,
    asyncRoute(async (request, response) => {
      const link = await db.query(
        "SELECT username, trim_scale(daily_cap_usdg)::text AS daily_cap_usdg, linked_at FROM telegram_links WHERE user_id = $1",
        [request.auth!.userId],
      );
      response.json({
        data: {
          enabled: telegramEnabled(),
          botUsername: env.TELEGRAM_BOT_USERNAME ?? null,
          link: link.rows[0] ?? null,
        },
      });
    }),
  );

  router.post(
    "/me/telegram/link",
    requireAuth,
    asyncRoute(async (request, response) => {
      const link = await createLinkCode(request.auth!.userId);
      await audit(db, {
        actorId: request.auth!.userId,
        action: "telegram.link_started",
        targetType: "user",
        targetId: request.auth!.userId,
        requestId: request.requestId,
      });
      response.status(201).json({ data: link });
    }),
  );

  router.put(
    "/me/telegram",
    requireAuth,
    asyncRoute(async (request, response) => {
      const { dailyCapUsdg } = z
        .object({ dailyCapUsdg: z.number().finite().min(0).max(100) })
        .parse(request.body);
      const updated = await db.query(
        `UPDATE telegram_links SET daily_cap_usdg = $2 WHERE user_id = $1
         RETURNING username, trim_scale(daily_cap_usdg)::text AS daily_cap_usdg, linked_at`,
        [request.auth!.userId, dailyCapUsdg],
      );
      if (!updated.rowCount) throw new ApiError(404, "telegram_not_linked", "Link Telegram first.");
      response.json({ data: updated.rows[0] });
    }),
  );

  router.delete(
    "/me/telegram",
    requireAuth,
    asyncRoute(async (request, response) => {
      await db.query("DELETE FROM telegram_links WHERE user_id = $1", [request.auth!.userId]);
      response.status(204).end();
    }),
  );
}
