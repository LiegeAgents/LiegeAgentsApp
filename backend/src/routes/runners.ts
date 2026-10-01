import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { audit } from "../audit.js";
import { decryptPayload, encryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { runSandboxed } from "../runner.js";
import { env } from "../config.js";

const input = z.object({
  agentId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
  command: z.enum(["node", "bun", "python", "python3"]),
  args: z.array(z.string().max(2_000)).max(40).default([]),
  env: z.record(z.string().max(4_000)).default({}),
  files: z
    .record(z.string().max(1_000_000))
    .refine((files) => Object.keys(files).length <= 20)
    .default({}),
  artifactPaths: z.array(z.string().max(200)).max(20).default([]),
  timeoutMs: z.coerce.number().int().min(100).max(120_000).default(30_000),
  maxOutputBytes: z.coerce.number().int().min(1_024).max(1_000_000).default(256_000),
});

export const runnersRouter = Router();
runnersRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const value = input.parse(request.body);
    const owned = await db.query("SELECT id FROM agents WHERE id = $1 AND owner_id = $2", [
      value.agentId,
      request.auth!.userId,
    ]);
    if (!owned.rowCount)
      throw new ApiError(404, "agent_not_found", "This agent is not owned by your account.");
    if (value.jobId) {
      const job = await db.query("SELECT id FROM jobs WHERE id = $1 AND agent_id = $2", [
        value.jobId,
        value.agentId,
      ]);
      if (!job.rowCount)
        throw new ApiError(404, "job_not_found", "This job is not attached to the agent.");
    }
    const created = await db.query<{ id: string }>(
      "INSERT INTO execution_runs (owner_id, agent_id, job_id, command, args, status, timeout_ms, max_output_bytes, started_at) VALUES ($1,$2,$3,$4,$5,'running',$6,$7,now()) RETURNING id",
      [
        request.auth!.userId,
        value.agentId,
        value.jobId ?? null,
        value.command,
        JSON.stringify(value.args),
        value.timeoutMs,
        value.maxOutputBytes,
      ],
    );
    const runId = created.rows[0].id;
    await audit(db, {
      actorId: request.auth!.userId,
      action: "runner.started",
      targetType: "execution_run",
      targetId: runId,
      requestId: request.requestId,
      metadata: { agentId: value.agentId, command: value.command, timeoutMs: value.timeoutMs },
    });
    let result;
    try {
      result = env.RUNNER_WORKER_URL ? await runRemote(value) : await runSandboxed(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.query(
        "UPDATE execution_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1",
        [runId, message],
      );
      await audit(db, {
        actorId: request.auth!.userId,
        action: "runner.failed",
        targetType: "execution_run",
        targetId: runId,
        requestId: request.requestId,
        metadata: { error: message },
      });
      throw error;
    }
    await db.query(
      "UPDATE execution_runs SET status=$2, exit_code=$3, stdout=$4, stderr=$5, error=$6, finished_at=now() WHERE id=$1",
      [runId, result.status, result.exitCode, result.stdout, result.stderr, result.error],
    );
    for (const artifact of result.artifacts)
      await db.query(
        "INSERT INTO execution_artifacts (run_id,name,size_bytes,sha256,content_ciphertext) VALUES ($1,$2,$3,$4,$5)",
        [
          runId,
          artifact.name,
          artifact.sizeBytes,
          artifact.sha256,
          encryptPayload(artifact.content.toString("base64"), payloadContext(runId, "artifact")),
        ],
      );
    await audit(db, {
      actorId: request.auth!.userId,
      action: `runner.${result.status}`,
      targetType: "execution_run",
      targetId: runId,
      requestId: request.requestId,
      metadata: { exitCode: result.exitCode, artifactCount: result.artifacts.length },
    });
    response.status(201).json({
      data: {
        id: runId,
        status: result.status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
        artifacts: result.artifacts.map(({ content: _content, ...artifact }) => artifact),
      },
    });
  }),
);

runnersRouter.get(
  "/:id/artifacts/:artifactId",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const artifactId = z.string().uuid().parse(request.params.artifactId);
    const result = await db.query<{ name: string; sha256: string; content_ciphertext: string }>(
      `SELECT a.name, a.sha256, a.content_ciphertext
       FROM execution_artifacts a JOIN execution_runs r ON r.id = a.run_id
       WHERE a.id=$1 AND a.run_id=$2 AND r.owner_id=$3`,
      [artifactId, id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "artifact_not_found", "This execution artifact is unavailable.");
    const content = decryptPayload(
      result.rows[0].content_ciphertext,
      payloadContext(id, "artifact"),
    );
    await audit(db, {
      actorId: request.auth!.userId,
      action: "runner.artifact_read",
      targetType: "execution_artifact",
      targetId: artifactId,
      requestId: request.requestId,
      metadata: { runId: id, name: result.rows[0].name },
    });
    response.json({
      data: { name: result.rows[0].name, sha256: result.rows[0].sha256, contentBase64: content },
    });
  }),
);

async function runRemote(value: z.infer<typeof input>) {
  if (!env.RUNNER_WORKER_TOKEN)
    throw new Error("RUNNER_WORKER_TOKEN is required when RUNNER_WORKER_URL is configured.");
  const response = await fetch(`${env.RUNNER_WORKER_URL}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-runner-token": env.RUNNER_WORKER_TOKEN },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(Math.min(value.timeoutMs + 10_000, 130_000)),
  });
  if (!response.ok) throw new Error(`Runner worker returned HTTP ${response.status}.`);
  const result = (await response.json()) as {
    runId: string;
    status: "completed" | "failed" | "timed_out";
    exitCode: number | null;
    stdout: string;
    stderr: string;
    error: string | null;
    artifacts: Array<{ name: string; sizeBytes: number; sha256: string; contentBase64: string }>;
  };
  return {
    ...result,
    artifacts: result.artifacts.map(({ contentBase64, ...artifact }) => ({
      ...artifact,
      content: Buffer.from(contentBase64, "base64"),
    })),
  };
}

runnersRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().parse(request.params.id);
    const result = await db.query(
      "SELECT id, agent_id, job_id, command, args, status, exit_code, timeout_ms, max_output_bytes, stdout, stderr, error, started_at, finished_at, created_at FROM execution_runs WHERE id=$1 AND owner_id=$2",
      [id, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "runner_not_found", "This execution run is unavailable.");
    const artifacts = await db.query(
      'SELECT id, name, size_bytes AS "sizeBytes", sha256, created_at FROM execution_artifacts WHERE run_id=$1 ORDER BY created_at',
      [id],
    );
    response.json({ data: { ...result.rows[0], artifacts: artifacts.rows } });
  }),
);
