import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { anchorData, receiptProof } from "../jobReceipts.js";

/** A settled job's receipt and Merkle proof, for the job's parties. Receipts outlive payloads. */
export function registerReceiptRoutes(router: Router) {
  router.get(
    "/:id/receipt",
    requireAuth,
    asyncRoute(async (request, response) => {
      const jobId = z.string().uuid().safeParse(request.params.id);
      const userId = request.auth!.userId;
      const job = jobId.success
        ? await db.query<{ status: string; agent_id: string }>(
            `SELECT j.status, j.agent_id FROM jobs j JOIN agents a ON a.id = j.agent_id
             WHERE j.id = $1 AND $2 IN (j.client_id, j.evaluator_id, a.owner_id)`,
            [jobId.data, userId],
          )
        : null;
      if (
        !job?.rowCount ||
        (request.runtimeAuth && !request.runtimeAuth.agentIds.includes(job.rows[0].agent_id))
      )
        throw new ApiError(404, "job_not_found", "This job is not available to this account.");
      const proof = await receiptProof(jobId.data!);
      if (!proof)
        throw new ApiError(
          404,
          "receipt_not_ready",
          ["completed", "rejected"].includes(job.rows[0].status)
            ? "The receipt for this job is being prepared. Check again in a few minutes."
            : "Receipts are issued once a job is accepted or rejected.",
        );
      response.json({ data: proof });
    }),
  );
}

/** Public: an anchored batch's root and transaction. It reveals nothing about any job. */
export const receiptAnchorsRouter = Router();
receiptAnchorsRouter.get(
  "/:id",
  asyncRoute(async (request, response) => {
    const id = z.string().uuid().safeParse(request.params.id);
    const found = id.success
      ? await db.query(
          `SELECT b.id, b.merkle_root, b.leaf_count, b.status, b.chain_id, b.anchor_address, b.tx_hash,
             b.block_number, b.created_at, b.confirmed_at,
             (SELECT count(*)::int FROM reputation_snapshots s WHERE s.batch_id = b.id) AS snapshots
           FROM receipt_batches b WHERE b.id = $1 AND b.status IN ('sent','confirmed')`,
          [id.data],
        )
      : null;
    const batch = found?.rows[0];
    if (!batch)
      throw new ApiError(404, "anchor_not_found", "No anchored receipt batch has that id.");
    response.json({
      data: {
        id: batch.id,
        merkleRoot: batch.merkle_root,
        // Leaves are job receipts followed by agents' reputation snapshots.
        receipts: batch.leaf_count - batch.snapshots,
        reputationSnapshots: batch.snapshots,
        status: batch.status,
        chainId: batch.chain_id,
        anchorAddress: batch.anchor_address,
        txHash: batch.tx_hash,
        blockNumber: batch.block_number ? Number(batch.block_number) : null,
        data: anchorData(batch.merkle_root),
        createdAt: new Date(batch.created_at).toISOString(),
        confirmedAt: batch.confirmed_at ? new Date(batch.confirmed_at).toISOString() : null,
      },
    });
  }),
);
