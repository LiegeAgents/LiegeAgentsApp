import { db } from "./db/index.js";

// Always join live resources: disabling a service or webhook removes discovery immediately.
export const readyEnrollment = `JOIN superagent_enrollments e ON e.agent_id=a.id
 JOIN commerce_services s ON s.id=e.service_id AND s.agent_id=a.id AND s.active
 JOIN webhook_subscriptions w ON w.id=e.webhook_id AND w.agent_id=a.id AND w.owner_id=a.owner_id AND w.active
 AND 'job.funded'=ANY(w.event_types)`;

export async function findEnrolledAgent(
  name: string | null,
  settlementAsset: "usdg" | "liege" = "usdg",
) {
  if (!name) return null;
  const result = await db.query(
    `SELECT a.id,a.name,a.slug,a.category,s.id AS service_id,s.slug AS service_slug,
       s.price_usd,s.sla_minutes,s.description,e.settlement_assets
     FROM agents a ${readyEnrollment}
     WHERE a.active AND e.enabled AND e.verified_at IS NOT NULL
       AND $3 = ANY(e.settlement_assets)
       AND (lower(a.name)=lower($1) OR lower(a.slug)=lower($2)
         OR lower(regexp_replace(a.name, ' by LiegeAgents$', '', 'i'))=lower($1))
     ORDER BY a.created_at LIMIT 2`,
    [
      name.trim(),
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
      settlementAsset,
    ],
  );
  // Ambiguous names must not silently select another provider.
  return result.rows.length === 1 ? result.rows[0] : null;
}
