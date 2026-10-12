import type { PoolClient } from "pg";
import { audit } from "./audit.js";
import { decryptPayload, payloadContext } from "./crypto.js";
import { ApiError } from "./http.js";
import { insertAttachment } from "./routes/jobAttachments.js";
import { fundLedgerJob, openSuperAgentJob, type SettlementAsset } from "./superAgentSchedules.js";

export const MIN_SQUAD_STEPS = 2;
export const MAX_SQUAD_STEPS = 5;

export type SquadRow = {
  id: string;
  user_id: string;
  request_ciphertext: string;
  settlement_asset: SettlementAsset;
  auto_fund: boolean;
  status: string;
};

type StepRow = {
  id: string;
  position: number;
  agent_id: string;
  agent_name: string;
  task: string;
  budget_amount: string;
  job_id: string | null;
};

/** The brief one step's agent receives: the whole request, the plan, and its own part in it. */
export function stepBrief(input: {
  request: string;
  steps: Array<{ agentName: string; task: string }>;
  position: number;
}) {
  const { request, steps, position } = input;
  const plan = steps
    .map(
      (step, index) =>
        `${index + 1}. ${step.agentName}: ${step.task}${index === position ? "  <- you" : ""}`,
    )
    .join("\n");
  return [
    `This job is step ${position + 1} of ${steps.length} in a Liege squad.`,
    "",
    `Squad request:\n${request}`,
    "",
    `The plan:\n${plan}`,
    "",
    `Your part: ${steps[position].task}`,
    position > 0
      ? "The deliverables from earlier steps are attached. Build on them rather than repeating them."
      : "Later agents build on your deliverable, so make it complete and well organized.",
  ].join("\n");
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "agent";

async function stepsOf(client: PoolClient, squadId: string) {
  const result = await client.query<StepRow>(
    `SELECT st.id, st.position, st.agent_id, a.name AS agent_name, st.task, st.budget_amount, st.job_id
     FROM superagent_squad_steps st JOIN agents a ON a.id = st.agent_id
     WHERE st.squad_id = $1 ORDER BY st.position`,
    [squadId],
  );
  return result.rows;
}

async function stopSquad(client: PoolClient, squad: SquadRow, reason: string) {
  await client.query(
    "UPDATE superagent_squads SET status='stopped', status_reason=$2, updated_at=now() WHERE id=$1",
    [squad.id, reason],
  );
}

/**
 * Opens the job for one step, attaches the earlier deliverables, and funds it from the client's
 * ledger balance when auto-funding is on. A step that cannot open stops the squad; a step that
 * cannot be funded waits for the client to fund it. Neither ever fails the caller.
 */
export async function startStep(
  client: PoolClient,
  squad: SquadRow,
  position: number,
  earlier: Array<{ agentName: string; position: number; deliverable: string }>,
) {
  const steps = await stepsOf(client, squad.id);
  const step = steps[position];
  const request = decryptPayload(squad.request_ciphertext, payloadContext(squad.id, "squad"));
  await client.query("SAVEPOINT squad_step_open");
  let job: Awaited<ReturnType<typeof openSuperAgentJob>>;
  try {
    job = await openSuperAgentJob(client, {
      userId: squad.user_id,
      agentId: step.agent_id,
      asset: squad.settlement_asset,
      budget: Number(step.budget_amount),
      request: stepBrief({
        request,
        steps: steps.map((item) => ({ agentName: item.agent_name, task: item.task })),
        position,
      }),
      policy: { squadId: squad.id, squadStep: position },
      title: `Squad ${position + 1}/${steps.length} · ${step.agent_name}: ${step.task}`,
    });
    await client.query("RELEASE SAVEPOINT squad_step_open");
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await client.query("ROLLBACK TO SAVEPOINT squad_step_open");
    await stopSquad(
      client,
      squad,
      `Step ${position + 1} (${step.agent_name}) could not start: ${error.message}`,
    );
    return { outcome: "stopped" as const, jobId: null };
  }
  for (const item of earlier) {
    const content = Buffer.from(item.deliverable, "utf8");
    await insertAttachment(client, {
      jobId: job.id,
      createdBy: squad.user_id,
      kind: "file",
      mediaType: "text/markdown",
      name: `step-${item.position + 1}-${slug(item.agentName)}.md`,
      content: content.toString("base64"),
      size: content.length,
    });
  }
  let detail: string | null = null;
  let outcome: "funded" | "awaiting_funding" = "awaiting_funding";
  if (!squad.auto_fund) detail = "Auto-funding is off. Fund this step in your dashboard.";
  else if (job.escrow_mode !== "ledger")
    detail = "On-chain escrow needs your wallet. Fund this step in your dashboard.";
  else {
    await client.query("SAVEPOINT squad_step_fund");
    try {
      await fundLedgerJob(client, job.id, squad.user_id);
      await client.query("RELEASE SAVEPOINT squad_step_fund");
      outcome = "funded";
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await client.query("ROLLBACK TO SAVEPOINT squad_step_fund");
      detail = `${error.message} Fund this step in your dashboard.`;
    }
  }
  await client.query(
    "UPDATE superagent_squad_steps SET job_id=$2, detail=$3, started_at=now() WHERE id=$1",
    [step.id, job.id, detail],
  );
  await client.query("UPDATE superagent_squads SET updated_at=now() WHERE id=$1", [squad.id]);
  await audit(client, {
    actorId: squad.user_id,
    action: "superagent.squad_step_started",
    targetType: "superagent_squad",
    targetId: squad.id,
    metadata: { position, jobId: job.id, outcome },
  });
  return { outcome, jobId: job.id };
}

/**
 * Called when a job is submitted. If it is a running squad's current step, the next step starts
 * with every earlier deliverable attached; after the last step the squad is complete. The client
 * still accepts or rejects each step's job on its own, so each agent is paid only for its step.
 */
export async function advanceSquad(client: PoolClient, jobId: string, deliverable: string) {
  const found = await client.query<SquadRow & { position: number }>(
    `SELECT q.id, q.user_id, q.request_ciphertext, q.settlement_asset, q.auto_fund, q.status, st.position
     FROM superagent_squad_steps st JOIN superagent_squads q ON q.id = st.squad_id
     WHERE st.job_id = $1 FOR UPDATE OF q`,
    [jobId],
  );
  const squad = found.rows[0];
  if (!squad || squad.status !== "running") return null;
  const steps = await stepsOf(client, squad.id);
  const next = steps[squad.position + 1];
  // A resubmission after a revision does not start the next step twice.
  if (next?.job_id) return null;
  if (!next) {
    await client.query(
      "UPDATE superagent_squads SET status='completed', status_reason=$2, updated_at=now() WHERE id=$1",
      [squad.id, `All ${steps.length} steps delivered.`],
    );
    return { outcome: "completed" as const, jobId: null };
  }
  const earlier: Array<{ agentName: string; position: number; deliverable: string }> = [];
  for (const step of steps.slice(0, squad.position)) {
    if (!step.job_id) continue;
    const submission = await client.query<{ deliverable_ciphertext: string | null }>(
      "SELECT deliverable_ciphertext FROM submissions WHERE job_id = $1",
      [step.job_id],
    );
    const ciphertext = submission.rows[0]?.deliverable_ciphertext;
    if (ciphertext)
      earlier.push({
        agentName: step.agent_name,
        position: step.position,
        deliverable: decryptPayload(ciphertext, payloadContext(step.job_id, "deliverable")),
      });
  }
  earlier.push({
    agentName: steps[squad.position].agent_name,
    position: squad.position,
    deliverable,
  });
  return startStep(client, squad, squad.position + 1, earlier);
}
