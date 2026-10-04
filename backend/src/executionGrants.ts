import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db/index.js";
import { decryptPayload, encryptPayload, payloadDigest, payloadContext } from "./crypto.js";

const grantHash = (token: string) => createHash("sha256").update(token).digest("hex");
const grantContext = (id: string) => payloadContext(id, "webhook-secret");

export async function issueExecutionGrant(input: {
  proposalId: string;
  userId: string;
  agentId: string;
  jobId: string;
  deliverable: string;
  expiresAt: Date;
}) {
  const token = `lxe_${randomBytes(32).toString("base64url")}`;
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO mcp_execution_grants
      (id,proposal_id,user_id,agent_id,job_id,deliverable_digest,token_hash,token_ciphertext,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (proposal_id) DO NOTHING`,
    [
      id,
      input.proposalId,
      input.userId,
      input.agentId,
      input.jobId,
      payloadDigest(input.deliverable),
      grantHash(token),
      encryptPayload(token, grantContext(id)),
      input.expiresAt,
    ],
  );
  return { id, token, expiresAt: input.expiresAt };
}

export async function readExecutionGrant(proposalId: string, agentId: string) {
  const result = await db.query<{
    id: string;
    job_id: string;
    deliverable_digest: string;
    token_ciphertext: string;
    expires_at: Date;
    used_at: Date | null;
  }>(
    `SELECT id,job_id,deliverable_digest,token_ciphertext,expires_at,used_at
     FROM mcp_execution_grants WHERE proposal_id=$1 AND agent_id=$2`,
    [proposalId, agentId],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    jobId: row.job_id,
    deliverableDigest: row.deliverable_digest,
    token: decryptPayload(row.token_ciphertext, grantContext(row.id)),
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

export async function consumeExecutionGrant(
  client: PoolClient,
  token: string,
  jobId: string,
  agentId: string,
  deliverable: string,
) {
  const result = await client.query<{
    id: string;
    user_id: string;
    agent_id: string;
    proposal_id: string;
    deliverable_digest: string;
  }>(
    `UPDATE mcp_execution_grants
     SET used_at=now()
     WHERE token_hash=$1 AND job_id=$2 AND agent_id=$3 AND used_at IS NULL AND expires_at > now()
     RETURNING id,user_id,agent_id,proposal_id,deliverable_digest`,
    [grantHash(token), jobId, agentId],
  );
  if (!result.rowCount) return null;
  const grant = result.rows[0];
  if (grant.deliverable_digest !== payloadDigest(deliverable)) return null;
  return grant;
}
