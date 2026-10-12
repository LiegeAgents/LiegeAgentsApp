import { randomUUID } from "node:crypto";
import express, { type Request, type Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { decryptPayload, encryptPayload, payloadContext, payloadDigest } from "../crypto.js";
import { db } from "../db/index.js";
import { isSafeEvidenceUrl } from "../evidence.js";
import { ApiError, asyncRoute } from "../http.js";

export const MAX_ATTACHMENTS = 5;
export const MAX_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const LINK_MEDIA_TYPE = "text/uri-list";

const textTypes = ["text/plain", "text/markdown", "text/csv"];
// Binary formats are checked against their leading bytes, not just the declared type.
const signatures: Record<string, (bytes: Buffer) => boolean> = {
  "application/pdf": (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
  "image/png": (bytes) =>
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/gif": (bytes) => ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")),
  "image/webp": (bytes) =>
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP",
};
export const ATTACHMENT_MEDIA_TYPES = [...Object.keys(signatures), ...textTypes];

/** The declared type if the bytes really are that type, else null. */
export function verifiedMediaType(declared: string | undefined, bytes: Buffer) {
  const type = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (signatures[type]) return signatures[type](bytes) ? type : null;
  if (!textTypes.includes(type) || bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return type;
  } catch {
    return null;
  }
}

const fileName = z
  .string()
  .transform((value) => value.split(/[\\/]/).at(-1)!.trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/\p{Cc}/u.test(value), "File names cannot contain control characters."),
  );

const linkInput = z.object({
  url: z
    .string()
    .trim()
    .max(2048)
    .refine(isSafeEvidenceUrl, "Links must be https:// URLs without embedded credentials."),
  // A commit pins a repository link to exactly the code the agent should review.
  commit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i, "commit must be a 7 to 40 character hex SHA.")
    .transform((value) => value.toLowerCase())
    .optional(),
});

type AttachmentRow = {
  id: string;
  kind: "file" | "link";
  media_type: string;
  size_bytes: number;
  name_ciphertext: string;
  created_at: Date;
};

const describe = (row: AttachmentRow) => ({
  id: row.id,
  kind: row.kind,
  name: decryptPayload(row.name_ciphertext, payloadContext(row.id, "attachment-name")),
  mediaType: row.media_type,
  sizeBytes: row.size_bytes,
  createdAt: row.created_at,
});

type Party = {
  agent_id: string;
  client_id: string;
  evaluator_id: string | null;
  provider_id: string;
  status: string;
  expires_at: Date;
};

/** Reads are for the job's parties; a runtime token needs its own agent and briefs:read. */
async function readableJob(request: Request, jobId: string) {
  const found = await db.query<Party>(
    `SELECT j.agent_id, j.client_id, j.evaluator_id, a.owner_id AS provider_id, j.status, j.expires_at
     FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1`,
    [jobId],
  );
  const job = found.rows[0];
  const userId = request.auth!.userId;
  if (!job || ![job.client_id, job.evaluator_id, job.provider_id].includes(userId))
    throw new ApiError(404, "job_not_found", "This job is not available to this account.");
  if (
    request.runtimeAuth &&
    (!request.runtimeAuth.agentIds.includes(job.agent_id) ||
      !request.runtimeAuth.scopes.includes("briefs:read"))
  )
    throw new ApiError(
      403,
      "runtime_scope_denied",
      "This runtime token cannot read this job's attachments.",
    );
  if (job.expires_at <= new Date())
    throw new ApiError(410, "payload_expired", "Private payload access for this job has expired.");
  return job;
}

/**
 * Stores one encrypted attachment. Callers check who may attach and the job's limits. The
 * statement time keeps attachments added in one transaction in the order they were added.
 */
export async function insertAttachment(
  client: PoolClient,
  input: {
    jobId: string;
    createdBy: string;
    kind: "file" | "link";
    mediaType: string;
    name: string;
    content: string;
    size: number;
  },
) {
  const id = randomUUID();
  const inserted = await client.query<AttachmentRow>(
    `INSERT INTO job_attachments (id, job_id, created_by, kind, media_type, size_bytes, name_ciphertext,
       content_ciphertext, content_hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp())
     RETURNING id, kind, media_type, size_bytes, name_ciphertext, created_at`,
    [
      id,
      input.jobId,
      input.createdBy,
      input.kind,
      input.mediaType,
      input.size,
      encryptPayload(input.name, payloadContext(id, "attachment-name")),
      encryptPayload(input.content, payloadContext(id, "attachment")),
      payloadDigest(input.content),
    ],
  );
  return inserted.rows[0];
}

/**
 * Adds one attachment for the client of an open job. Attachments are fixed once the job is
 * funded, so the agent always works from the inputs the client paid for.
 */
async function addAttachment(
  request: Request,
  jobId: string,
  attachment: {
    kind: "file" | "link";
    mediaType: string;
    name: string;
    content: string;
    size: number;
  },
) {
  const userId = request.auth!.userId;
  if (request.runtimeAuth)
    throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot add attachments.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<Party & { count: number; total: number }>(
      `SELECT j.agent_id, j.client_id, j.evaluator_id, a.owner_id AS provider_id, j.status, j.expires_at,
         (SELECT count(*)::int FROM job_attachments x WHERE x.job_id = j.id) AS count,
         (SELECT COALESCE(sum(size_bytes), 0)::int FROM job_attachments x WHERE x.job_id = j.id) AS total
       FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE OF j`,
      [jobId],
    );
    const job = found.rows[0];
    if (!job || ![job.client_id, job.evaluator_id, job.provider_id].includes(userId))
      throw new ApiError(404, "job_not_found", "This job is not available to this account.");
    if (job.client_id !== userId)
      throw new ApiError(403, "not_client", "Only the job client can add attachments.");
    if (job.status !== "open")
      throw new ApiError(
        409,
        "attachments_locked",
        "Attachments can only change before the job is funded.",
      );
    if (job.count >= MAX_ATTACHMENTS)
      throw new ApiError(
        409,
        "attachment_limit",
        `A job can have at most ${MAX_ATTACHMENTS} attachments.`,
      );
    if (job.total + attachment.size > MAX_TOTAL_BYTES)
      throw new ApiError(
        413,
        "attachment_limit",
        `A job's attachments can total at most ${MAX_TOTAL_BYTES / 1024 / 1024} MB.`,
      );
    const inserted = await insertAttachment(client, { jobId, createdBy: userId, ...attachment });
    const id = inserted.id;
    await audit(client, {
      actorId: userId,
      action: "job.attachment_added",
      targetType: "job",
      targetId: jobId,
      requestId: request.requestId,
      metadata: {
        attachmentId: id,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.size,
      },
    });
    await client.query("COMMIT");
    return describe(inserted);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function registerAttachmentRoutes(router: Router) {
  // Links travel as JSON. The stored content is {url, commit} and the name is the URL itself.
  router.post(
    "/:id/attachments",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const link = linkInput.parse(request.body);
      const content = JSON.stringify(link);
      response.status(201).json({
        data: await addAttachment(request, jobId, {
          kind: "link",
          mediaType: LINK_MEDIA_TYPE,
          name: link.commit ? `${link.url}@${link.commit}` : link.url,
          content,
          size: Buffer.byteLength(content),
        }),
      });
    }),
  );

  // Files are sent as the raw request body with their own Content-Type and ?name=.
  router.post(
    "/:id/attachments/file",
    requireAuth,
    express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const name = fileName.parse(request.query.name);
      const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (!bytes.length)
        throw new ApiError(400, "attachment_empty", "Send the file as the request body.");
      const mediaType = verifiedMediaType(request.get("content-type"), bytes);
      if (!mediaType)
        throw new ApiError(
          415,
          "unsupported_attachment",
          `Attach a PDF, PNG, JPEG, GIF, WebP, or UTF-8 text file (${ATTACHMENT_MEDIA_TYPES.join(", ")}).`,
        );
      response.status(201).json({
        data: await addAttachment(request, jobId, {
          kind: "file",
          mediaType,
          name,
          content: bytes.toString("base64"),
          size: bytes.length,
        }),
      });
    }),
  );

  router.get(
    "/:id/attachments",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      await readableJob(request, jobId);
      const rows = await db.query<AttachmentRow>(
        `SELECT id, kind, media_type, size_bytes, name_ciphertext, created_at
         FROM job_attachments WHERE job_id = $1 ORDER BY created_at, id`,
        [jobId],
      );
      response.json({ data: rows.rows.map(describe) });
    }),
  );

  router.get(
    "/:id/attachments/:attachmentId",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const attachmentId = z.string().uuid().parse(request.params.attachmentId);
      await readableJob(request, jobId);
      const found = await db.query<AttachmentRow & { content_ciphertext: string }>(
        `SELECT id, kind, media_type, size_bytes, name_ciphertext, content_ciphertext, created_at
         FROM job_attachments WHERE id = $1 AND job_id = $2`,
        [attachmentId, jobId],
      );
      const row = found.rows[0];
      if (!row) throw new ApiError(404, "attachment_not_found", "This job has no such attachment.");
      const content = decryptPayload(row.content_ciphertext, payloadContext(row.id, "attachment"));
      await audit(db, {
        actorId: request.auth!.userId,
        action: "job.attachment_accessed",
        targetType: "job",
        targetId: jobId,
        requestId: request.requestId,
        metadata: { attachmentId },
      });
      response.json({
        data: {
          ...describe(row),
          ...(row.kind === "link"
            ? (JSON.parse(content) as { url: string; commit?: string })
            : { data: content }),
        },
      });
    }),
  );

  router.delete(
    "/:id/attachments/:attachmentId",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().parse(request.params.id);
      const attachmentId = z.string().uuid().parse(request.params.attachmentId);
      const userId = request.auth!.userId;
      if (request.runtimeAuth)
        throw new ApiError(
          403,
          "runtime_scope_denied",
          "Runtime tokens cannot remove attachments.",
        );
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query<Party>(
          `SELECT j.agent_id, j.client_id, j.evaluator_id, a.owner_id AS provider_id, j.status, j.expires_at
           FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE OF j`,
          [jobId],
        );
        const job = found.rows[0];
        if (!job || ![job.client_id, job.evaluator_id, job.provider_id].includes(userId))
          throw new ApiError(404, "job_not_found", "This job is not available to this account.");
        if (job.client_id !== userId)
          throw new ApiError(403, "not_client", "Only the job client can remove attachments.");
        if (job.status !== "open")
          throw new ApiError(
            409,
            "attachments_locked",
            "Attachments can only change before the job is funded.",
          );
        const removed = await client.query(
          "DELETE FROM job_attachments WHERE id = $1 AND job_id = $2",
          [attachmentId, jobId],
        );
        if (!removed.rowCount)
          throw new ApiError(404, "attachment_not_found", "This job has no such attachment.");
        await audit(client, {
          actorId: userId,
          action: "job.attachment_removed",
          targetType: "job",
          targetId: jobId,
          requestId: request.requestId,
          metadata: { attachmentId },
        });
        await client.query("COMMIT");
        response.status(204).end();
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }),
  );
}
