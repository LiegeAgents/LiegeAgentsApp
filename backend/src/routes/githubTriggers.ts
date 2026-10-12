import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { audit } from "../audit.js";
import { env } from "../config.js";
import { decryptPayload, encryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { insertAttachment, LINK_MEDIA_TYPE } from "./jobAttachments.js";
import {
  fundLedgerJob,
  openSuperAgentJob,
  readySuperAgent,
  type SettlementAsset,
} from "../superAgentSchedules.js";

const MAX_ACTIVE_TRIGGERS = 20;
const REVIEW_ACTIONS = ["opened", "reopened", "synchronize", "ready_for_review"];
export const DEFAULT_INSTRUCTIONS =
  "Review this pull request for correctness, security, and maintainability. Prioritize findings by severity and suggest concrete fixes.";

const repository = z
  .string()
  .trim()
  .transform((value) =>
    value
      .replace(/^https:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, ""),
  )
  .pipe(z.string().regex(/^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/, "Use owner/repository."));

const triggerInput = z
  .object({
    agentId: z.string().uuid(),
    repository,
    branch: z.string().trim().min(1).max(255).default("main"),
    instructions: z.string().trim().min(1).max(2000).default(DEFAULT_INSTRUCTIONS),
    settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
    budgetAmount: z.number().finite().positive(),
    spendCap: z.number().finite().positive(),
    autoFund: z.boolean().default(false),
    postComment: z.boolean().default(true),
    source: z.enum(["dashboard", "cli"]).default("dashboard"),
  })
  .refine((input) => input.spendCap >= input.budgetAmount, {
    message: "The spending cap must cover at least one review.",
    path: ["spendCap"],
  });

// Only the fields a review needs; everything else in GitHub's payload is ignored.
const pullRequestEvent = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string(), private: z.boolean() }),
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string().max(1000),
    html_url: z.string().url(),
    draft: z.boolean().optional(),
    base: z.object({ ref: z.string() }),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  }),
});

const triggerColumns = `t.id, t.agent_id, a.name AS agent_name, t.repository, t.branch, t.instructions,
  t.settlement_asset, t.budget_amount, t.spend_cap, t.committed_amount, t.runs_count, t.auto_fund,
  t.post_comment, t.verified_at, t.status, t.status_reason, t.source, t.created_at, t.updated_at,
  COALESCE((SELECT json_agg(r ORDER BY r.created_at DESC) FROM (
    SELECT r.id, r.pull_number, r.head_sha, r.title, r.outcome, r.detail, r.created_at, r.job_id,
      j.status AS job_status
    FROM superagent_trigger_runs r LEFT JOIN jobs j ON j.id = r.job_id
    WHERE r.trigger_id = t.id ORDER BY r.created_at DESC LIMIT 10) r), '[]'::json) AS runs`;

const setupFor = (trigger: { id: string; repository: string; secret: string }) => ({
  payloadUrl: `${env.PUBLIC_API_URL.replace(/\/$/, "")}/v1/github/hooks/${trigger.id}`,
  contentType: "application/json",
  secret: trigger.secret,
  events: ["pull_request"],
  settingsUrl: `https://github.com/${trigger.repository}/settings/hooks/new`,
});

async function ownedTrigger(id: string, userId: string, withSetup = false) {
  const result = await db.query(
    `SELECT ${triggerColumns}, t.secret_ciphertext FROM superagent_triggers t
     JOIN agents a ON a.id = t.agent_id WHERE t.id = $1 AND t.user_id = $2`,
    [id, userId],
  );
  if (!result.rowCount)
    throw new ApiError(404, "trigger_not_found", "This GitHub trigger is not available.");
  const { secret_ciphertext: ciphertext, ...trigger } = result.rows[0];
  return withSetup
    ? {
        ...trigger,
        setup: setupFor({
          id: trigger.id,
          repository: trigger.repository,
          secret: decryptPayload(ciphertext, payloadContext(trigger.id, "github-trigger")),
        }),
      }
    : trigger;
}

export function registerTriggerRoutes(router: Router) {
  // Like a recurring job, a trigger authorizes future spending: operator sessions only.
  router.post(
    "/triggers",
    requireAuth,
    asyncRoute(async (request, response) => {
      if (request.runtimeAuth)
        throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot create triggers.");
      const input = triggerInput.parse(request.body);
      const userId = request.auth!.userId;
      const id = randomUUID();
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`triggers:${userId}`]);
        const active = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM superagent_triggers WHERE user_id=$1 AND status IN ('active','paused')",
          [userId],
        );
        if (active.rows[0].count >= MAX_ACTIVE_TRIGGERS)
          throw new ApiError(
            409,
            "trigger_limit",
            `You can keep up to ${MAX_ACTIVE_TRIGGERS} GitHub triggers. Cancel one first.`,
          );
        await readySuperAgent(
          client,
          input.agentId,
          input.settlementAsset,
          userId,
          input.budgetAmount,
        );
        await client.query(
          `INSERT INTO superagent_triggers (id, user_id, agent_id, repository, branch, instructions,
             settlement_asset, budget_amount, spend_cap, auto_fund, post_comment, secret_ciphertext, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            userId,
            input.agentId,
            input.repository,
            input.branch,
            input.instructions,
            input.settlementAsset,
            String(input.budgetAmount),
            String(input.spendCap),
            input.autoFund,
            input.postComment,
            encryptPayload(randomBytes(32).toString("hex"), payloadContext(id, "github-trigger")),
            input.source,
          ],
        );
        await audit(client, {
          actorId: userId,
          action: "superagent.trigger_created",
          targetType: "superagent_trigger",
          targetId: id,
          requestId: request.requestId,
          metadata: {
            agentId: input.agentId,
            repository: input.repository,
            branch: input.branch,
            budgetAmount: input.budgetAmount,
            spendCap: input.spendCap,
            autoFund: input.autoFund,
            source: input.source,
          },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      response.status(201).json({ data: await ownedTrigger(id, userId, true) });
    }),
  );

  router.get(
    "/triggers",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const result = await db.query(
        `SELECT ${triggerColumns} FROM superagent_triggers t JOIN agents a ON a.id = t.agent_id
         WHERE t.user_id = $1 ORDER BY (t.status IN ('active','paused')) DESC, t.created_at DESC LIMIT 100`,
        [request.auth!.userId],
      );
      response.json({ data: result.rows });
    }),
  );

  // The setup (payload URL and secret) is shown again here so the owner can finish connecting.
  router.get(
    "/triggers/:id",
    requireAuth,
    asyncRoute(async (request, response) => {
      if (request.runtimeAuth)
        throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot read triggers.");
      const id = z.string().uuid().parse(request.params.id);
      response.json({ data: await ownedTrigger(id, request.auth!.userId, true) });
    }),
  );

  const control = (action: "pause" | "resume" | "cancel", from: string[], to: string) =>
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      const userId = request.auth!.userId;
      const updated = await db.query(
        `UPDATE superagent_triggers SET status=$3, status_reason=$4, updated_at=now()
         WHERE id=$1 AND user_id=$2 AND status = ANY($5::text[]) RETURNING id`,
        [
          id,
          userId,
          to,
          action === "resume" ? null : action === "pause" ? "Paused by you." : "Cancelled by you.",
          from,
        ],
      );
      if (!updated.rowCount) {
        await ownedTrigger(id, userId);
        throw new ApiError(409, "invalid_trigger_transition", `This trigger cannot ${action}.`);
      }
      await audit(db, {
        actorId: userId,
        action: `superagent.trigger_${{ pause: "paused", resume: "resumed", cancel: "cancelled" }[action]}`,
        targetType: "superagent_trigger",
        targetId: id,
        requestId: request.requestId,
      });
      response.json({ data: await ownedTrigger(id, userId) });
    });

  router.post(
    "/triggers/:id/pause",
    requireSessionOrMobileAuth("mobile:approve"),
    control("pause", ["active"], "paused"),
  );
  // Resuming re-authorizes spending, so it needs an operator session.
  router.post("/triggers/:id/resume", requireAuth, control("resume", ["paused"], "active"));
  router.delete(
    "/triggers/:id",
    requireSessionOrMobileAuth("mobile:approve"),
    control("cancel", ["active", "paused"], "cancelled"),
  );
}

type TriggerRow = {
  id: string;
  user_id: string;
  agent_id: string;
  agent_name: string;
  repository: string;
  branch: string;
  instructions: string;
  settlement_asset: SettlementAsset;
  budget_amount: string;
  spend_cap: string;
  committed_amount: string;
  auto_fund: boolean;
  post_comment: boolean;
  status: string;
  secret_ciphertext: string;
};

/** Opens the review job for one pull request update, within the trigger's cap. */
async function runTrigger(
  client: PoolClient,
  trigger: TriggerRow,
  delivery: string,
  pull: z.infer<typeof pullRequestEvent>["pull_request"],
  isPrivate: boolean,
) {
  const budget = Number(trigger.budget_amount);
  let outcome: "funded" | "awaiting_funding" | "skipped" | "failed" = "skipped";
  let detail: string | null = null;
  let jobId: string | null = null;
  const reviewing = await client.query(
    `SELECT 1 FROM superagent_trigger_runs r JOIN jobs j ON j.id = r.job_id
     WHERE r.trigger_id = $1 AND r.pull_number = $2 AND j.status IN ('open', 'funded') LIMIT 1`,
    [trigger.id, pull.number],
  );
  if (isPrivate) {
    outcome = "failed";
    detail = "Private repositories are not supported yet.";
  } else if (reviewing.rowCount) {
    // One review per pull request at a time; a push during a review does not pile up jobs.
    detail = `Already reviewing #${pull.number}.`;
  } else if (Number(trigger.committed_amount) + budget > Number(trigger.spend_cap)) {
    detail = "Spending cap reached.";
  } else {
    await client.query("SAVEPOINT trigger_open");
    try {
      const job = await openSuperAgentJob(client, {
        userId: trigger.user_id,
        agentId: trigger.agent_id,
        asset: trigger.settlement_asset,
        budget,
        request: `${trigger.instructions}\n\nPull request #${pull.number} in ${trigger.repository}: ${pull.title}\n${pull.html_url}\nHead commit: ${pull.head.sha}\n\nThe pull request is attached; review its changes.`,
        policy: {
          triggerId: trigger.id,
          github: {
            repository: trigger.repository,
            pull: pull.number,
            headSha: pull.head.sha,
            postComment: trigger.post_comment,
          },
        },
        title: `Review ${trigger.repository}#${pull.number}: ${pull.title}`,
      });
      await client.query("RELEASE SAVEPOINT trigger_open");
      jobId = job.id;
      const link = JSON.stringify({ url: pull.html_url, commit: pull.head.sha });
      await insertAttachment(client, {
        jobId: job.id,
        createdBy: trigger.user_id,
        kind: "link",
        mediaType: LINK_MEDIA_TYPE,
        name: `${pull.html_url}@${pull.head.sha}`,
        content: link,
        size: Buffer.byteLength(link),
      });
      await client.query(
        `UPDATE superagent_triggers SET committed_amount = committed_amount + $2,
           runs_count = runs_count + 1, updated_at = now() WHERE id = $1`,
        [trigger.id, String(budget)],
      );
      outcome = "awaiting_funding";
      if (!trigger.auto_fund) detail = "Auto-funding is off. Fund this review in your dashboard.";
      else if (job.escrow_mode !== "ledger")
        detail = "On-chain escrow needs your wallet. Fund this review in your dashboard.";
      else {
        await client.query("SAVEPOINT trigger_fund");
        try {
          await fundLedgerJob(client, job.id, trigger.user_id);
          await client.query("RELEASE SAVEPOINT trigger_fund");
          outcome = "funded";
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          await client.query("ROLLBACK TO SAVEPOINT trigger_fund");
          detail = `${error.message} Fund this review in your dashboard.`;
        }
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await client.query("ROLLBACK TO SAVEPOINT trigger_open");
      outcome = "failed";
      detail = error.message;
    }
  }
  await client.query(
    `INSERT INTO superagent_trigger_runs (trigger_id, delivery_id, pull_number, head_sha, title, job_id, outcome, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      trigger.id,
      delivery,
      pull.number,
      pull.head.sha,
      pull.title.slice(0, 300),
      jobId,
      outcome,
      detail,
    ],
  );
  if (
    detail === "Spending cap reached." ||
    Number(trigger.committed_amount) + (jobId ? budget : 0) + budget > Number(trigger.spend_cap)
  )
    await client.query(
      "UPDATE superagent_triggers SET status='completed', status_reason='Spending cap reached.', updated_at=now() WHERE id=$1",
      [trigger.id],
    );
  await audit(client, {
    actorId: trigger.user_id,
    action: "superagent.trigger_run",
    targetType: "superagent_trigger",
    targetId: trigger.id,
    metadata: { delivery, pull: pull.number, headSha: pull.head.sha, outcome, jobId },
  });
  return { outcome, jobId, detail };
}

const validSignature = (secret: string, body: Buffer, header: string | undefined) => {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(header.slice(7), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/**
 * GitHub's webhook endpoint. It is public, so everything is checked: the trigger exists, the
 * body is signed with its secret, and the event names its repository and branch. Only pull
 * requests that are opened, reopened, updated, or marked ready for review start a job.
 */
export const githubHooksRouter = Router();
githubHooksRouter.post(
  "/hooks/:id",
  express.raw({ type: () => true, limit: "2mb" }),
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().safeParse(request.params.id);
    const found = id.success
      ? await db.query<TriggerRow>(
          `SELECT t.*, a.name AS agent_name FROM superagent_triggers t JOIN agents a ON a.id = t.agent_id
           WHERE t.id = $1`,
          [id.data],
        )
      : null;
    const trigger = found?.rows[0];
    if (!trigger) throw new ApiError(404, "trigger_not_found", "No such GitHub trigger.");
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const secret = decryptPayload(
      trigger.secret_ciphertext,
      payloadContext(trigger.id, "github-trigger"),
    );
    if (!validSignature(secret, body, request.get("x-hub-signature-256")))
      throw new ApiError(401, "invalid_signature", "The webhook signature does not match.");
    const event = request.get("x-github-event");
    const delivery = request.get("x-github-delivery");
    if (!event || !delivery || delivery.length > 100)
      throw new ApiError(400, "invalid_delivery", "GitHub event headers are missing.");
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new ApiError(400, "invalid_json", "Set the webhook content type to application/json.");
    }
    const repo = (payload as { repository?: { full_name?: string } })?.repository?.full_name;
    if (typeof repo !== "string" || repo.toLowerCase() !== trigger.repository.toLowerCase())
      throw new ApiError(422, "repository_mismatch", "This webhook belongs to another repository.");
    await db.query(
      "UPDATE superagent_triggers SET verified_at = COALESCE(verified_at, now()) WHERE id = $1",
      [trigger.id],
    );
    const ignore = (reason: string) =>
      response.status(202).json({ data: { status: "ignored", reason } });
    if (event === "ping") return response.json({ data: { status: "connected" } });
    if (event !== "pull_request") return ignore(`event_${event}`);
    const parsed = pullRequestEvent.safeParse(payload);
    if (!parsed.success)
      throw new ApiError(400, "invalid_event", "Unrecognized pull request event.");
    const { action, pull_request: pull } = parsed.data;
    if (!REVIEW_ACTIONS.includes(action)) return ignore(`action_${action}`);
    if (pull.draft) return ignore("draft");
    if (pull.base.ref !== trigger.branch) return ignore("other_branch");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<TriggerRow>(
        `SELECT t.*, a.name AS agent_name FROM superagent_triggers t JOIN agents a ON a.id = t.agent_id
         WHERE t.id = $1 FOR UPDATE OF t`,
        [trigger.id],
      );
      const current = locked.rows[0];
      const seen = await client.query(
        "SELECT 1 FROM superagent_trigger_runs WHERE trigger_id = $1 AND delivery_id = $2",
        [trigger.id, delivery],
      );
      if (seen.rowCount || current.status !== "active") {
        await client.query("ROLLBACK");
        return ignore(seen.rowCount ? "duplicate_delivery" : `trigger_${current.status}`);
      }
      const result = await runTrigger(
        client,
        current,
        delivery,
        pull,
        parsed.data.repository.private,
      );
      await client.query("COMMIT");
      response
        .status(202)
        .json({ data: { status: result.outcome, jobId: result.jobId, detail: result.detail } });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }),
);
