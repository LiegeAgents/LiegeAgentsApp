import { decryptPayload, payloadContext } from "./crypto.js";
import { db } from "./db/index.js";

/**
 * What an agent remembers about one client: the preferences the client wrote, and the feedback
 * the client gave in revisions of earlier jobs with that agent (newest first, at most five, and
 * only since the client last cleared memory). Off means the agent gets nothing.
 */
export const MAX_LEARNED = 5;

export type Memory = {
  enabled: boolean;
  preferences: string | null;
  learned: Array<{ jobTitle: string; feedback: string; at: Date }>;
};

export async function readMemory(
  clientId: string,
  agentId: string,
  excludeJobId?: string,
): Promise<Memory> {
  const row = (
    await db.query<{
      id: string;
      enabled: boolean;
      preferences_ciphertext: string | null;
      cleared_at: Date | null;
    }>(
      "SELECT id, enabled, preferences_ciphertext, cleared_at FROM agent_memory WHERE client_id = $1 AND agent_id = $2",
      [clientId, agentId],
    )
  ).rows[0];
  if (row && !row.enabled) return { enabled: false, preferences: null, learned: [] };
  const revisions = await db.query<{
    job_id: string;
    title: string;
    feedback_ciphertext: string;
    created_at: Date;
  }>(
    `SELECT r.job_id, j.title, r.feedback_ciphertext, r.created_at
     FROM job_revisions r JOIN jobs j ON j.id = r.job_id
     WHERE j.client_id = $1 AND j.agent_id = $2 AND ($3::uuid IS NULL OR j.id <> $3)
       AND ($4::timestamptz IS NULL OR r.created_at > $4)
     ORDER BY r.created_at DESC LIMIT ${MAX_LEARNED}`,
    [clientId, agentId, excludeJobId ?? null, row?.cleared_at ?? null],
  );
  return {
    enabled: true,
    preferences: row?.preferences_ciphertext
      ? decryptPayload(row.preferences_ciphertext, payloadContext(row.id, "agent-memory"))
      : null,
    learned: revisions.rows.map((item) => ({
      jobTitle: item.title,
      feedback: decryptPayload(item.feedback_ciphertext, payloadContext(item.job_id, "revision")),
      at: item.created_at,
    })),
  };
}
