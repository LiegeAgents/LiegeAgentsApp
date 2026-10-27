import type { PoolClient } from "pg";

/**
 * The refund owed for delivering past a job's promise, as a share of the budget in raw units.
 * Lateness is measured from the first delivery (a revision the client asked for never counts)
 * against funding time plus the promised minutes, in started hours. The amount is recorded on
 * the job so both sides can see it.
 */
export async function lateRefundRaw(client: PoolClient, jobId: string, budgetRaw: bigint) {
  const found = await client.query<{
    promised_minutes: number | null;
    per_hour: number | null;
    max_bps: number | null;
    funded_at: Date | null;
    first_delivery: Date | null;
  }>(
    `SELECT j.promised_minutes, j.late_refund_bps_per_hour AS per_hour,
       j.late_refund_max_bps AS max_bps, j.funded_at,
       COALESCE(r.previous_submitted_at, j.submitted_at) AS first_delivery
     FROM jobs j LEFT JOIN job_revisions r ON r.job_id = j.id WHERE j.id = $1`,
    [jobId],
  );
  const job = found.rows[0];
  if (!job?.promised_minutes || !job.funded_at || !job.first_delivery || !job.per_hour) return 0n;
  const promised = job.funded_at.getTime() + job.promised_minutes * 60_000;
  const late = job.first_delivery.getTime() - promised;
  if (late <= 0) return 0n;
  const bps = Math.min(Math.ceil(late / 3_600_000) * job.per_hour, job.max_bps ?? 0);
  return (budgetRaw * BigInt(bps)) / 10_000n;
}

export async function recordLateRefund(client: PoolClient, jobId: string, amount: string) {
  await client.query("UPDATE jobs SET late_refund_amount = $2 WHERE id = $1", [jobId, amount]);
}
