import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  "/",
  asyncRoute(async (request, response) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(request.query);
    const userId = request.auth!.userId;
    const [items, count] = await Promise.all([
      db.query(
        `SELECT id, job_id, event_type, title, message, read_at, created_at
         FROM notifications WHERE user_id = $1
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [userId, query.limit],
      ),
      db.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
        [userId],
      ),
    ]);
    response.json({ data: { items: items.rows, unreadCount: Number(count.rows[0].count) } });
  }),
);

notificationsRouter.post(
  "/read-all",
  asyncRoute(async (request, response) => {
    const result = await db.query(
      "UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL RETURNING id",
      [request.auth!.userId],
    );
    response.json({ data: { markedRead: result.rowCount ?? 0, unreadCount: 0 } });
  }),
);

notificationsRouter.post(
  "/:id/read",
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      `UPDATE notifications SET read_at = COALESCE(read_at, now())
       WHERE id = $1 AND user_id = $2
       RETURNING id, job_id, event_type, title, message, read_at, created_at`,
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "notification_not_found", "This notification was not found.");
    response.json({ data: result.rows[0] });
  }),
);
