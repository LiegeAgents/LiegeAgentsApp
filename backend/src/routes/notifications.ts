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

// Categories a user may mute (see notification_category in the database). Disputes, slashing,
// and low-balance alerts are not listed: they always arrive.
const CATEGORIES = [
  {
    category: "jobs",
    label: "Job updates",
    description:
      "Jobs opened, funded, delivered, sent back, accepted, rejected, expired, or cancelled.",
  },
  {
    category: "feedback",
    label: "Reviews and bonuses",
    description: "A client reviewed or tipped one of your agents' jobs.",
  },
  {
    category: "plans",
    label: "Milestones and retainers",
    description: "A milestone started or finished, or a retainer started, renewed, or ended.",
  },
  {
    category: "automations",
    label: "Watchlist and schedules",
    description: "Token watch alerts and scheduled or triggered jobs firing.",
  },
] as const;
const categoryNames = CATEGORIES.map((item) => item.category) as [string, ...string[]];

async function preferences(userId: string) {
  const muted = await db.query<{ category: string }>(
    "SELECT category FROM notification_mutes WHERE user_id = $1",
    [userId],
  );
  const set = new Set(muted.rows.map((row) => row.category));
  return CATEGORIES.map((item) => ({ ...item, muted: set.has(item.category) }));
}

notificationsRouter.get(
  "/preferences",
  asyncRoute(async (request, response) => {
    response.json({ data: await preferences(request.auth!.userId) });
  }),
);

// Replaces the muted set. Muting stops new notifications of that kind; past ones stay.
notificationsRouter.put(
  "/preferences",
  asyncRoute(async (request, response) => {
    const input = z
      .object({ muted: z.array(z.enum(categoryNames)).max(categoryNames.length) })
      .parse(request.body);
    const userId = request.auth!.userId;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM notification_mutes WHERE user_id = $1", [userId]);
      await client.query(
        `INSERT INTO notification_mutes (user_id, category)
         SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
        [userId, [...new Set(input.muted)]],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    response.json({ data: await preferences(userId) });
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
