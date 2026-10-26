import type { PoolClient } from "pg";
import { assetLabel, type SettlementAsset } from "./assets.js";
import { audit } from "./audit.js";
import { env } from "./config.js";
import { encryptPayload, payloadContext, payloadDigest } from "./crypto.js";
import { db } from "./db/index.js";
import { ApiError } from "./http.js";
import { settleOutcome, startOnchainSettlement, type LedgerJob } from "./jobPayouts.js";
import { heldAccounts, transfer, userBalance } from "./ledger.js";
import { lockEvaluator, minimumEvaluatorStake } from "./capacity.js";
import { enqueueWebhookEvent } from "./webhooks.js";

/**
 * The challenge window. On a ledger or Liege onchain escrow job with a window, the evaluator's
 * decision is recorded
 * but the escrow stays put until payout_due_at. Before then the side the decision went against
 * (the client for an acceptance, the agent owner for a rejection) may challenge it by posting a
 * bond. A Liege arbitrator then upholds the challenge, which reverses the outcome, or denies it,
 * which keeps the outcome and pays the bond to the other side. Either way the job settles then.
 */

type DecidedJob = LedgerJob & {
  status: string;
  evaluator_id: string | null;
  escrow_mode: string;
  payout_due_at: Date | null;
  payout_released_at: Date | null;
  past_due: boolean;
};

const MIN_BOND: Record<SettlementAsset, number> = { usdg: 0.01, liege: 1 };

export function challengeBond(job: Pick<LedgerJob, "budget_amount" | "settlement_asset">) {
  const decimals = job.settlement_asset === "liege" ? 18 : 6;
  const bond = (Number(job.budget_amount) * env.CHALLENGE_BOND_BPS) / 10_000;
  return Math.max(MIN_BOND[job.settlement_asset], Number(bond.toFixed(decimals)));
}

async function lockDecided(client: PoolClient, jobId: string) {
  const result = await client.query<DecidedJob>(
    `SELECT j.*, a.owner_id AS provider_id, j.payout_due_at <= now() AS past_due
     FROM jobs j JOIN agents a ON a.id = j.agent_id WHERE j.id = $1 FOR UPDATE OF j`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

/** Who decided the job: the evaluator who recorded the decision. */
async function decidedBy(client: PoolClient, jobId: string) {
  const result = await client.query<{ evaluator_id: string; outcome: "accepted" | "rejected" }>(
    "SELECT evaluator_id, outcome FROM evaluations WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
    [jobId],
  );
  return result.rows[0];
}

async function settle(
  client: PoolClient,
  job: DecidedJob,
  outcome: "accepted" | "rejected",
  evaluatorId: string,
  actorId: string,
) {
  const onchain = await settleOutcome(client, job, outcome, evaluatorId, actorId);
  const status = outcome === "accepted" ? "completed" : "rejected";
  await client.query(
    `UPDATE jobs SET status = '${status}', settled_at = now(), payout_released_at = now(),
       updated_at = now() WHERE id = $1`,
    [job.id],
  );
  await client.query("INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)", [
    job.id,
    actorId,
    "job.settled",
  ]);
  await enqueueWebhookEvent(client, { jobId: job.id, eventType: "job.settled", actorId });
  return onchain;
}

export async function openChallenge(input: {
  jobId: string;
  userId: string;
  reason: string;
  requestId?: string;
}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const job = await lockDecided(client, input.jobId);
    if (!job || (job.client_id !== input.userId && job.provider_id !== input.userId))
      throw new ApiError(404, "job_not_found", "This job does not exist.");
    if (job.status === "challenged")
      throw new ApiError(409, "already_challenged", "This decision is already being challenged.");
    if (
      !job.payout_due_at ||
      job.payout_released_at ||
      !["completed", "rejected"].includes(job.status)
    )
      throw new ApiError(
        409,
        "not_challengeable",
        "Only a decision still inside its challenge window can be challenged.",
      );
    if (job.past_due)
      throw new ApiError(409, "challenge_window_closed", "The challenge window has closed.");
    const decision = await decidedBy(client, job.id);
    // The side the decision went against challenges it.
    const loser = decision.outcome === "accepted" ? job.client_id : job.provider_id;
    if (input.userId !== loser)
      throw new ApiError(
        403,
        "not_challenger",
        decision.outcome === "accepted"
          ? "Only the client can challenge an acceptance."
          : "Only the agent owner can challenge a rejection.",
      );
    const bond = challengeBond(job);
    const accounts = await heldAccounts(client, input.userId, job.settlement_asset);
    await transfer(client, {
      reference: `challenge-bond:${job.id}`,
      type: "challenge_bond",
      from: accounts.available,
      to: accounts.held,
      amount: bond,
      asset: job.settlement_asset,
      createdBy: input.userId,
      metadata: { jobId: job.id },
      insufficientFunds: new ApiError(
        402,
        "insufficient_bond",
        `A challenge needs a bond of ${bond} ${assetLabel(job.settlement_asset)} from your available balance. It comes back if the challenge is upheld.`,
      ),
    });
    const dispute = await client.query<{ id: string }>(
      `INSERT INTO disputes (job_id, challenger_id, original_evaluator_id, reason_ciphertext, reason_hash,
         challenge_bond_usdg, asset, decided_outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        job.id,
        input.userId,
        decision.evaluator_id,
        encryptPayload(input.reason, payloadContext(job.id, "challenge")),
        payloadDigest(input.reason),
        bond,
        job.settlement_asset,
        decision.outcome,
      ],
    );
    await client.query("UPDATE jobs SET status = 'challenged', updated_at = now() WHERE id = $1", [
      job.id,
    ]);
    const event = await client.query<{ id: string; created_at: Date }>(
      "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3) RETURNING id, created_at",
      [job.id, input.userId, "job.challenged"],
    );
    await drawPanel(client, {
      disputeId: dispute.rows[0].id,
      job,
      excluded: [job.client_id, job.provider_id, decision.evaluator_id, input.userId],
      event: event.rows[0],
    });
    await audit(client, {
      actorId: input.userId,
      action: "job.challenged",
      targetType: "job",
      targetId: job.id,
      requestId: input.requestId,
      metadata: { disputeId: dispute.rows[0].id, bond, decidedOutcome: decision.outcome },
    });
    await client.query("COMMIT");
    return dispute.rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type DisputeRow = {
  id: string;
  job_id: string;
  challenger_id: string;
  original_evaluator_id: string;
  challenge_bond_usdg: string;
  asset: SettlementAsset;
  decided_outcome: "accepted" | "rejected";
  status: string;
  mode: "arbitrator" | "panel";
  panel_deadline_at: Date | null;
  panel_deciding: boolean;
};

async function lockDispute(client: PoolClient, disputeId: string) {
  const found = await client.query<DisputeRow>(
    `SELECT *, (mode = 'panel' AND panel_deadline_at > now()) AS panel_deciding
     FROM disputes WHERE id = $1 FOR UPDATE`,
    [disputeId],
  );
  const dispute = found.rows[0];
  if (!dispute) throw new ApiError(404, "dispute_not_found", "Dispute not found.");
  if (dispute.status !== "open")
    throw new ApiError(409, "dispute_resolved", "This dispute is already resolved.");
  return dispute;
}

/**
 * Settles a dispute on its resolution: the bond goes back to an upheld challenger or to the other
 * side of a denied one, and the job settles on its final outcome.
 */
async function applyResolution(
  client: PoolClient,
  dispute: DisputeRow,
  input: {
    resolution: "upheld" | "denied";
    rationale: string;
    actorId: string;
    // The arbitrator, or null when the panel decided.
    resolverId: string | null;
    requestId?: string;
  },
) {
  const job = (await lockDecided(client, dispute.job_id))!;
  const upheld = input.resolution === "upheld";
  const finalOutcome = upheld
    ? dispute.decided_outcome === "accepted"
      ? "rejected"
      : "accepted"
    : dispute.decided_outcome;
  const counterparty = dispute.challenger_id === job.client_id ? job.provider_id : job.client_id;
  const challenger = await heldAccounts(client, dispute.challenger_id, dispute.asset);
  const bondTo = upheld
    ? challenger.available
    : (await heldAccounts(client, counterparty, dispute.asset)).available;
  await transfer(client, {
    reference: `challenge-bond-${upheld ? "return" : "forfeit"}:${job.id}`,
    type: upheld ? "challenge_bond_return" : "challenge_bond_forfeit",
    from: challenger.held,
    to: bondTo,
    amount: dispute.challenge_bond_usdg,
    asset: dispute.asset,
    createdBy: input.actorId,
    metadata: { jobId: job.id, disputeId: dispute.id },
  });
  // An overturned evaluator forfeits their fee: on a reversed rejection it goes back to the client.
  const onchain = await settle(
    client,
    job,
    finalOutcome,
    upheld ? job.client_id : dispute.original_evaluator_id,
    input.actorId,
  );
  const slashed = upheld ? await slashEvaluator(client, job, dispute, input.actorId) : null;
  await client.query(
    `UPDATE disputes SET status = $2, resolution = $3, resolver_id = $4,
       resolution_rationale_ciphertext = $5, resolved_at = now(),
       slashed_evaluator_id = $6, slashed_amount = $7 WHERE id = $1`,
    [
      dispute.id,
      finalOutcome === "accepted" ? "resolved_provider" : "resolved_client",
      input.resolution,
      input.resolverId,
      encryptPayload(input.rationale, payloadContext(job.id, "challenge-resolution")),
      slashed?.evaluatorId ?? null,
      slashed?.amount ?? null,
    ],
  );
  await client.query("INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,$3)", [
    job.id,
    input.actorId,
    `job.challenge_${input.resolution}`,
  ]);
  await audit(client, {
    actorId: input.actorId,
    action: `dispute.${input.resolution}`,
    targetType: "dispute",
    targetId: dispute.id,
    requestId: input.requestId,
    metadata: {
      jobId: job.id,
      finalOutcome,
      by: input.resolverId ? "arbitrator" : "panel",
      slashed: slashed?.amount ?? null,
    },
  });
  return {
    disputeId: dispute.id,
    jobId: job.id,
    resolution: input.resolution,
    finalOutcome,
    slashed,
    // Liege onchain escrow: its transfers start once the transaction commits.
    settlesOnchain: onchain,
  };
}

/**
 * Slashes the independent evaluator whose decision was overturned: SLASH_BPS of the budget, up
 * to the stake they hold in the job's asset, moves from their stake to the challenger. Clients
 * who decided their own job hold no evaluator stake and are not slashed. Ledger only: no wallet
 * or contract is touched.
 */
async function slashEvaluator(
  client: PoolClient,
  job: DecidedJob,
  dispute: DisputeRow,
  actorId: string,
) {
  const evaluatorId = job.evaluator_id;
  if (!evaluatorId || evaluatorId === job.client_id || !env.SLASH_BPS) return null;
  await lockEvaluator(client, evaluatorId);
  const stake = await userBalance(client, evaluatorId, "stake", job.settlement_asset);
  const decimals = job.settlement_asset === "liege" ? 18 : 6;
  const target = (Number(job.budget_amount) * env.SLASH_BPS) / 10_000;
  const amount = Number(Math.min(target, stake.amount).toFixed(decimals));
  if (amount <= 0) return null;
  const challenger = await userBalance(
    client,
    dispute.challenger_id,
    "available",
    job.settlement_asset,
  );
  await transfer(client, {
    reference: `evaluator-slash:${job.id}`,
    type: "evaluator_slash",
    from: stake.accountId,
    to: challenger.accountId,
    amount,
    asset: job.settlement_asset,
    createdBy: actorId,
    metadata: { jobId: job.id, disputeId: dispute.id, evaluatorId },
  });
  const event = await client.query<{ id: string; created_at: Date }>(
    "INSERT INTO job_events (job_id, actor_id, event_type) VALUES ($1,$2,'evaluator.slashed') RETURNING id, created_at",
    [job.id, actorId],
  );
  await client.query(
    `INSERT INTO notifications (user_id, job_id, event_id, event_type, title, message, created_at)
     VALUES ($1,$2,$3,'evaluator.slashed',$4,$5,$6) ON CONFLICT (user_id, event_id) DO NOTHING`,
    [
      evaluatorId,
      job.id,
      event.rows[0].id,
      "Your decision was overturned",
      `A challenge to your decision was upheld, so ${amount} ${assetLabel(job.settlement_asset)} of your stake went to the challenger.`,
      event.rows[0].created_at,
    ],
  );
  return { evaluatorId, amount: String(amount) };
}

/** A Liege arbitrator's decision: for disputes without a panel, or whose panel ran out of time. */
export async function resolveChallenge(input: {
  disputeId: string;
  resolverId: string;
  resolution: "upheld" | "denied";
  rationale: string;
  requestId?: string;
}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const dispute = await lockDispute(client, input.disputeId);
    if (dispute.panel_deciding)
      throw new ApiError(
        409,
        "panel_deciding",
        "An evaluator panel is deciding this dispute; an arbitrator steps in only after its deadline.",
      );
    const job = (await lockDecided(client, dispute.job_id))!;
    if ([job.client_id, job.provider_id, dispute.original_evaluator_id].includes(input.resolverId))
      throw new ApiError(
        403,
        "arbitrator_conflict",
        "A party to the job cannot arbitrate its dispute.",
      );
    const result = await applyResolution(client, dispute, {
      ...input,
      actorId: input.resolverId,
    });
    await client.query("COMMIT");
    if (result.settlesOnchain) startOnchainSettlement(result.jobId);
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Draws the panel for a new dispute: independent, active evaluators with at least the minimum
 * stake in the job's asset, chosen at random. Too few eligible evaluators leaves it to a Liege
 * arbitrator.
 */
async function drawPanel(
  client: PoolClient,
  input: {
    disputeId: string;
    job: DecidedJob;
    excluded: string[];
    event: { id: string; created_at: Date };
  },
) {
  const size = env.DISPUTE_PANEL_SIZE;
  if (!size) return;
  const drawn = await client.query<{ user_id: string }>(
    `SELECT p.user_id FROM evaluator_profiles p
     WHERE p.active AND NOT (p.user_id = ANY($1::uuid[]))
       AND COALESCE((SELECT sum(lp.amount) FROM ledger_accounts la
                     JOIN ledger_postings lp ON lp.account_id = la.id
                     WHERE la.user_id = p.user_id AND la.kind = 'stake' AND la.asset = $2), 0) >= $3
     ORDER BY random() LIMIT $4`,
    [
      input.excluded,
      input.job.settlement_asset,
      minimumEvaluatorStake(input.job.settlement_asset),
      size,
    ],
  );
  if (drawn.rows.length < size) return;
  await client.query(
    `UPDATE disputes SET mode = 'panel',
       panel_deadline_at = now() + ($2::int * interval '1 hour') WHERE id = $1`,
    [input.disputeId, env.DISPUTE_PANEL_HOURS],
  );
  for (const member of drawn.rows) {
    await client.query(
      "INSERT INTO dispute_panel_members (dispute_id, evaluator_id) VALUES ($1,$2)",
      [input.disputeId, member.user_id],
    );
    await client.query(
      `INSERT INTO notifications (user_id, job_id, event_id, event_type, title, message, created_at)
       VALUES ($1,$2,$3,'dispute.panel_drawn',$4,$5,$6) ON CONFLICT (user_id, event_id) DO NOTHING`,
      [
        member.user_id,
        input.job.id,
        input.event.id,
        "You were drawn for a dispute panel",
        `A decision was challenged. Review the job and vote within ${env.DISPUTE_PANEL_HOURS} hours; the majority decides.`,
        input.event.created_at,
      ],
    );
  }
}

/**
 * Records a panelist's vote. Once a majority agrees, the dispute is resolved on it and every vote
 * cast so far counts toward the voters' accuracy.
 */
export async function castPanelVote(input: {
  disputeId: string;
  evaluatorId: string;
  decision: "upheld" | "denied";
  rationale: string;
  requestId?: string;
}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const dispute = await lockDispute(client, input.disputeId);
    const members = await client.query<{
      id: string;
      evaluator_id: string;
      decision: string | null;
    }>(
      "SELECT id, evaluator_id, decision FROM dispute_panel_members WHERE dispute_id = $1 ORDER BY created_at, evaluator_id",
      [dispute.id],
    );
    const me = members.rows.find((row) => row.evaluator_id === input.evaluatorId);
    if (!me) throw new ApiError(404, "dispute_not_found", "Dispute not found.");
    if (me.decision) throw new ApiError(409, "already_voted", "You already voted on this dispute.");
    if (!dispute.panel_deciding)
      throw new ApiError(
        409,
        "panel_closed",
        "The panel's deadline has passed; a Liege arbitrator will decide.",
      );
    await client.query(
      `UPDATE dispute_panel_members SET decision = $3, rationale_ciphertext = $4, decided_at = now()
       WHERE dispute_id = $1 AND evaluator_id = $2`,
      [
        dispute.id,
        input.evaluatorId,
        input.decision,
        encryptPayload(input.rationale, payloadContext(me.id, "panel-vote")),
      ],
    );
    const votes = members.rows.map((row) =>
      row.evaluator_id === input.evaluatorId ? input.decision : row.decision,
    );
    const majority = Math.floor(members.rows.length / 2) + 1;
    const count = (decision: string) => votes.filter((vote) => vote === decision).length;
    const decided =
      count("upheld") >= majority ? "upheld" : count("denied") >= majority ? "denied" : null;
    let result: Awaited<ReturnType<typeof applyResolution>> | null = null;
    if (decided) {
      result = await applyResolution(client, dispute, {
        resolution: decided,
        rationale: `Evaluator panel: ${count("upheld")} upheld, ${count("denied")} denied of ${members.rows.length}.`,
        actorId: input.evaluatorId,
        resolverId: null,
        requestId: input.requestId,
      });
      for (const [index, row] of members.rows.entries()) {
        const vote = votes[index];
        if (!vote) continue;
        await client.query(
          `UPDATE evaluator_profiles SET completed_count = completed_count + 1,
             correct_count = correct_count + $2, updated_at = now() WHERE user_id = $1`,
          [row.evaluator_id, vote === decided ? 1 : 0],
        );
      }
    }
    await client.query("COMMIT");
    if (result?.settlesOnchain) startOnchainSettlement(result.jobId);
    return {
      disputeId: dispute.id,
      vote: input.decision,
      votes: { upheld: count("upheld"), denied: count("denied"), of: members.rows.length },
      resolved: result,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Pays out unchallenged decisions whose window has closed. Each job settles once. */
export async function releaseDuePayouts(limit = 50) {
  const released: string[] = [];
  for (let index = 0; index < limit; index++) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const due = await client.query<{ id: string }>(
        `SELECT id FROM jobs WHERE payout_due_at <= now() AND payout_released_at IS NULL
           AND status IN ('completed', 'rejected')
         ORDER BY payout_due_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!due.rowCount) {
        await client.query("COMMIT");
        break;
      }
      const job = (await lockDecided(client, due.rows[0].id))!;
      const decision = await decidedBy(client, job.id);
      const onchain = await settle(
        client,
        job,
        decision.outcome,
        decision.evaluator_id,
        decision.evaluator_id,
      );
      await client.query("COMMIT");
      if (onchain) startOnchainSettlement(job.id);
      released.push(job.id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return released;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startPayoutReleases() {
  if (timer || env.NODE_ENV === "test") return;
  timer = setInterval(() => {
    void releaseDuePayouts().catch((error) =>
      console.error(
        JSON.stringify({
          event: "payouts.release_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }, 60_000);
  timer.unref();
}
export function stopPayoutReleases() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
