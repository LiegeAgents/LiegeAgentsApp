import type { Pool, PoolClient } from "pg";

type AuditTarget = {
  actorId?: string;
  action: string;
  targetType: string;
  targetId: string;
  requestId?: string;
  metadata?: object;
};
export async function audit(db: Pool | PoolClient, entry: AuditTarget) {
  await db.query(
    "INSERT INTO audit_logs (actor_id, action, target_type, target_id, request_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)",
    [
      entry.actorId ?? null,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.requestId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
