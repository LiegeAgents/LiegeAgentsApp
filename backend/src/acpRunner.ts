import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit.js";
import { agentActionDigest, canonical, normalizeAgentAction } from "./agentActions.js";
import { encryptPayload, payloadContext } from "./crypto.js";
import { db } from "./db/index.js";
import { recordTrace } from "./observability.js";
import { runIsolated } from "./runner.js";

const requestSchema = z.object({
  actionId: z.string().uuid(),
  simulationId: z.string().uuid(),
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

export async function executeAcpRunner(agentId: string, ownerId: string, raw: unknown) {
  const input = requestSchema.parse(raw);
  if (input.jobId) {
    const job = await db.query("SELECT id FROM jobs WHERE id=$1 AND agent_id=$2", [
      input.jobId,
      agentId,
    ]);
    if (!job.rowCount) throw new Error("The ACP runner request is not attached to this agent.");
  }

  const details = {
    command: input.command,
    args: input.args,
    jobId: input.jobId ?? null,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
    envDigest: createHash("sha256").update(canonical(input.env)).digest("hex"),
    filesDigest: createHash("sha256").update(canonical(input.files)).digest("hex"),
  };
  const account = await db.query<{ status: string }>(
    "SELECT status FROM agent_accounts WHERE agent_id=$1",
    [agentId],
  );
  if (!account.rowCount || account.rows[0].status !== "active")
    throw new Error("The agent account is not active.");
  const action = await db.query<{
    id: string;
    policy_version: number;
    simulation_id: string;
    normalized_action: Record<string, unknown>;
  }>(
    `SELECT a.id,a.policy_version,a.simulation_id,a.normalized_action
     FROM agent_account_actions a
     WHERE a.id=$1 AND a.agent_id=$2 AND a.simulation_id=$3
       AND a.decision='approved' AND a.execution_status='not_started'`,
    [input.actionId, agentId, input.simulationId],
  );
  const expected = normalizeAgentAction({ action: "runner.execute", details });
  if (
    !action.rowCount ||
    agentActionDigest(agentId, Number(action.rows[0].policy_version), expected) !==
      agentActionDigest(
        agentId,
        Number(action.rows[0].policy_version),
        action.rows[0].normalized_action as typeof expected,
      )
  )
    throw new Error("The ACP runner request does not match its approved simulation.");
  const claimed = await db.query<{ id: string }>(
    "UPDATE agent_account_actions SET execution_status='running' WHERE id=$1 AND execution_status='not_started' RETURNING id",
    [input.actionId],
  );
  if (!claimed.rowCount)
    throw new Error("The approved ACP runner action is already running or complete.");

  let created: { rows: { id: string }[] };
  try {
    created = await db.query<{ id: string }>(
      `INSERT INTO execution_runs
        (owner_id,agent_id,job_id,command,args,status,timeout_ms,max_output_bytes,agent_account_action_id,started_at)
       VALUES ($1,$2,$3,$4,$5,'running',$6,$7,$8,now()) RETURNING id`,
      [
        ownerId,
        agentId,
        input.jobId ?? null,
        input.command,
        JSON.stringify(input.args),
        input.timeoutMs,
        input.maxOutputBytes,
        input.actionId,
      ],
    );
  } catch (error) {
    await db.query(
      "UPDATE agent_account_actions SET execution_status='failed',executed_at=now() WHERE id=$1",
      [input.actionId],
    );
    throw error;
  }
  const runId = created.rows[0].id;
  await recordTrace(db, runId, "runtime", {
    command: input.command,
    timeoutMs: input.timeoutMs,
    maxOutputBytes: input.maxOutputBytes,
  });
  try {
    const result = await runIsolated(input);
    await db.query(
      "UPDATE execution_runs SET status=$2,exit_code=$3,stdout=$4,stderr=$5,error=$6,finished_at=now() WHERE id=$1",
      [runId, result.status, result.exitCode, result.stdout, result.stderr, result.error],
    );
    await db.query(
      "UPDATE agent_account_actions SET execution_status=$2,executed_at=now() WHERE id=$1",
      [input.actionId, result.status === "completed" ? "succeeded" : "failed"],
    );
    for (const artifact of result.artifacts) {
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
      await recordTrace(db, runId, "artifact", {
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
      });
    }
    await recordTrace(db, runId, "outcome", {
      status: result.status,
      exitCode: result.exitCode,
      artifactCount: result.artifacts.length,
    });
    await audit(db, {
      actorId: ownerId,
      action: `runner.${result.status}`,
      targetType: "execution_run",
      targetId: runId,
      metadata: { source: "virtuals_acp", agentId, acpActionId: input.actionId },
    });
    return {
      runId,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
      artifacts: result.artifacts.map(({ content, ...artifact }) => ({
        ...artifact,
        contentBase64: content.toString("base64"),
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query(
      "UPDATE execution_runs SET status='failed',error=$2,finished_at=now() WHERE id=$1",
      [runId, message],
    );
    await db.query(
      "UPDATE agent_account_actions SET execution_status='failed',executed_at=now() WHERE id=$1",
      [input.actionId],
    );
    await recordTrace(db, runId, "outcome", { status: "failed" });
    throw error;
  }
}
