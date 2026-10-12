import { randomUUID } from "node:crypto";
import type { Request, Router } from "express";
import { z } from "zod";
import { requireAuth, requireSessionOrMobileAuth } from "../auth.js";
import { audit } from "../audit.js";
import { selfSettlementLimit } from "../capacity.js";
import { decryptPayload, encryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { readyEnrollment } from "../superAgentEnrollment.js";
import { fundLedgerJob, openSuperAgentJob, type SettlementAsset } from "../superAgentSchedules.js";
import { enqueueWebhookEvent } from "../webhooks.js";

export const MAX_INVITED_AGENTS = 8;
// After bidding closes the client still has a day to hire one of the bids.
const AWARD_WINDOW_MS = 86_400_000;

const auctionInput = z.object({
  request: z.string().trim().min(1).max(10_000),
  settlementAsset: z.enum(["usdg", "liege"]).default("usdg"),
  maxBudget: z.number().finite().positive().optional(),
  biddingMinutes: z.number().int().min(1).max(60).default(5),
  // Invite only these agents; otherwise every eligible Super Agent is invited.
  agentIds: z.array(z.string().uuid()).min(1).max(MAX_INVITED_AGENTS).optional(),
  source: z.enum(["dashboard", "cli"]).default("dashboard"),
});

const bidInput = z.union([
  z.object({ decline: z.literal(true), reason: z.string().trim().max(500).optional() }),
  z.object({
    decline: z.literal(false).optional(),
    price: z.number().finite().positive(),
    deliveryMinutes: z.number().int().min(5).max(10_080),
    approach: z.string().trim().min(1).max(1_500),
  }),
]);

const awardInput = z.object({ bidId: z.string().uuid(), fund: z.boolean().default(false) });

type AuctionRow = {
  id: string;
  user_id: string;
  request_ciphertext: string;
  settlement_asset: SettlementAsset;
  max_budget: string | null;
  closes_at: Date;
  status: "open" | "awarded" | "cancelled";
  awarded_bid_id: string | null;
  job_id: string | null;
  source: string;
  created_at: Date;
};

type BidRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  status: string;
  price: string | null;
  delivery_minutes: number | null;
  approach_ciphertext: string | null;
  submitted_at: Date | null;
  listed_price_usd: string | null;
  sla_minutes: number | null;
};

const phase = (auction: AuctionRow) =>
  auction.status !== "open"
    ? auction.status
    : auction.closes_at > new Date()
      ? "bidding"
      : new Date(auction.closes_at.getTime() + AWARD_WINDOW_MS) > new Date()
        ? "choosing"
        : "expired";

async function auctionView(auction: AuctionRow) {
  const bids = await db.query<BidRow>(
    `SELECT b.id, b.agent_id, a.name AS agent_name, b.status, b.price, b.delivery_minutes,
       b.approach_ciphertext, b.submitted_at, s.price_usd AS listed_price_usd, s.sla_minutes
     FROM superagent_bids b JOIN agents a ON a.id = b.agent_id
     LEFT JOIN superagent_enrollments e ON e.agent_id = b.agent_id
     LEFT JOIN commerce_services s ON s.id = e.service_id
     WHERE b.auction_id = $1
     ORDER BY (b.status IN ('submitted','won')) DESC, b.price ASC NULLS LAST, b.submitted_at`,
    [auction.id],
  );
  return {
    id: auction.id,
    request: decryptPayload(auction.request_ciphertext, payloadContext(auction.id, "auction")),
    settlementAsset: auction.settlement_asset,
    maxBudget: auction.max_budget === null ? null : Number(auction.max_budget),
    closesAt: auction.closes_at,
    status: auction.status,
    phase: phase(auction),
    awardedBidId: auction.awarded_bid_id,
    jobId: auction.job_id,
    source: auction.source,
    createdAt: auction.created_at,
    bids: bids.rows.map((bid) => ({
      id: bid.id,
      agentId: bid.agent_id,
      agentName: bid.agent_name,
      status: bid.status,
      price: bid.price === null ? null : Number(bid.price),
      deliveryMinutes: bid.delivery_minutes,
      approach: bid.approach_ciphertext
        ? decryptPayload(bid.approach_ciphertext, payloadContext(bid.id, "bid"))
        : null,
      submittedAt: bid.submitted_at,
      listedPriceUsd: bid.listed_price_usd === null ? null : Number(bid.listed_price_usd),
      slaMinutes: bid.sla_minutes,
    })),
  };
}

async function ownedAuction(id: string, userId: string) {
  const found = await db.query<AuctionRow>(
    "SELECT * FROM superagent_auctions WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  if (!found.rowCount)
    throw new ApiError(404, "auction_not_found", "This request for bids is not available.");
  return found.rows[0];
}

/**
 * The bid as its agent sees it. The agent's owner, or that owner's runtime token scoped to the
 * agent, may read and answer it; nobody else learns the request.
 */
async function agentBid(
  request: Request,
  bidId: string,
  scope: "briefs:read" | "deliverables:write",
) {
  const found = await db.query<{
    id: string;
    agent_id: string;
    owner_id: string;
    status: string;
    auction_id: string;
    request_ciphertext: string;
    settlement_asset: SettlementAsset;
    max_budget: string | null;
    closes_at: Date;
    auction_status: string;
    service_slug: string | null;
    listed_price_usd: string | null;
    sla_minutes: number | null;
  }>(
    `SELECT b.id, b.agent_id, a.owner_id, b.status, q.id AS auction_id, q.request_ciphertext,
       q.settlement_asset, q.max_budget, q.closes_at, q.status AS auction_status,
       s.slug AS service_slug, s.price_usd AS listed_price_usd, s.sla_minutes
     FROM superagent_bids b JOIN agents a ON a.id = b.agent_id
     JOIN superagent_auctions q ON q.id = b.auction_id
     LEFT JOIN superagent_enrollments e ON e.agent_id = b.agent_id
     LEFT JOIN commerce_services s ON s.id = e.service_id
     WHERE b.id = $1`,
    [bidId],
  );
  const bid = found.rows[0];
  if (!bid || bid.owner_id !== request.auth!.userId)
    throw new ApiError(404, "bid_not_found", "This bid is not available to this account.");
  if (
    request.runtimeAuth &&
    (!request.runtimeAuth.agentIds.includes(bid.agent_id) ||
      !request.runtimeAuth.scopes.includes(scope))
  )
    throw new ApiError(403, "runtime_scope_denied", "This runtime token cannot use this bid.");
  return bid;
}

export function registerAuctionRoutes(router: Router) {
  // Posting a request for bids authorizes nothing yet, but it shares the request with the invited
  // agents, so it needs an operator session rather than a runtime token.
  router.post(
    "/auctions",
    requireAuth,
    asyncRoute(async (request, response) => {
      if (request.runtimeAuth)
        throw new ApiError(403, "runtime_scope_denied", "Runtime tokens cannot ask for bids.");
      const input = auctionInput.parse(request.body);
      const userId = request.auth!.userId;
      const client = await db.connect();
      let auctionId: string;
      try {
        await client.query("BEGIN");
        const eligible = await client.query<{ id: string }>(
          `SELECT a.id FROM agents a ${readyEnrollment}
           WHERE a.active AND e.enabled AND e.verified_at IS NOT NULL
             AND $1 = ANY(e.settlement_assets) AND a.owner_id <> $2
             AND ($3::uuid[] IS NULL OR a.id = ANY($3::uuid[]))
           ORDER BY a.created_at LIMIT ${MAX_INVITED_AGENTS}`,
          [input.settlementAsset, userId, input.agentIds ?? null],
        );
        if (!eligible.rowCount)
          throw new ApiError(
            422,
            "no_eligible_agents",
            `No Super Agent can take ${input.settlementAsset.toUpperCase()} jobs right now.`,
          );
        auctionId = randomUUID();
        await client.query(
          `INSERT INTO superagent_auctions (id, user_id, request_ciphertext, settlement_asset, max_budget,
             closes_at, source)
           VALUES ($1,$2,$3,$4,$5, now() + $6 * interval '1 minute', $7)`,
          [
            auctionId,
            userId,
            encryptPayload(input.request, payloadContext(auctionId, "auction")),
            input.settlementAsset,
            input.maxBudget === undefined ? null : String(input.maxBudget),
            input.biddingMinutes,
            input.source,
          ],
        );
        for (const agent of eligible.rows) {
          const bidId = randomUUID();
          await client.query(
            "INSERT INTO superagent_bids (id, auction_id, agent_id) VALUES ($1,$2,$3)",
            [bidId, auctionId, agent.id],
          );
          // The event names the bid only; the agent reads the request through the API.
          await enqueueWebhookEvent(client, {
            bidId,
            eventType: "auction.bid_requested",
            actorId: userId,
            data: { auctionId },
          });
        }
        await audit(client, {
          actorId: userId,
          action: "superagent.auction_created",
          targetType: "superagent_auction",
          targetId: auctionId,
          requestId: request.requestId,
          metadata: {
            invited: eligible.rowCount,
            asset: input.settlementAsset,
            maxBudget: input.maxBudget ?? null,
            biddingMinutes: input.biddingMinutes,
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
      response.status(201).json({ data: await auctionView(await ownedAuction(auctionId, userId)) });
    }),
  );

  router.get(
    "/auctions",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const found = await db.query<AuctionRow>(
        "SELECT * FROM superagent_auctions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20",
        [request.auth!.userId],
      );
      response.json({ data: await Promise.all(found.rows.map(auctionView)) });
    }),
  );

  router.get(
    "/auctions/:id",
    requireSessionOrMobileAuth("mobile:read"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      response.json({ data: await auctionView(await ownedAuction(id, request.auth!.userId)) });
    }),
  );

  // Hiring a bid opens an ordinary Super Agent job at the bid's price and delivery time, the same
  // job an approved proposal opens. With fund, ledger escrow is funded from the client's balance.
  router.post(
    "/auctions/:id/award",
    requireSessionOrMobileAuth("mobile:approve"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      const input = awardInput.parse(request.body);
      const userId = request.auth!.userId;
      const client = await db.connect();
      let job: Awaited<ReturnType<typeof openSuperAgentJob>>;
      let funded = false;
      try {
        await client.query("BEGIN");
        const found = await client.query<AuctionRow>(
          "SELECT * FROM superagent_auctions WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [id, userId],
        );
        const auction = found.rows[0];
        if (!auction)
          throw new ApiError(404, "auction_not_found", "This request for bids is not available.");
        if (!["bidding", "choosing"].includes(phase(auction)))
          throw new ApiError(
            409,
            "auction_closed",
            "This request for bids can no longer be awarded.",
          );
        const bid = await client.query<{
          id: string;
          agent_id: string;
          agent_name: string;
          price: string;
          delivery_minutes: number;
          approach_ciphertext: string;
        }>(
          `SELECT b.id, b.agent_id, a.name AS agent_name, b.price, b.delivery_minutes, b.approach_ciphertext
           FROM superagent_bids b JOIN agents a ON a.id = b.agent_id
           WHERE b.id = $1 AND b.auction_id = $2 AND b.status = 'submitted'`,
          [input.bidId, id],
        );
        if (!bid.rowCount)
          throw new ApiError(404, "bid_not_found", "Hire a bid an agent has submitted.");
        const winner = bid.rows[0];
        const requestText = decryptPayload(
          auction.request_ciphertext,
          payloadContext(auction.id, "auction"),
        );
        const approach = decryptPayload(
          winner.approach_ciphertext,
          payloadContext(winner.id, "bid"),
        );
        job = await openSuperAgentJob(client, {
          userId,
          agentId: winner.agent_id,
          asset: auction.settlement_asset,
          budget: Number(winner.price),
          request: `${requestText}\n\nYou won this job with this approach. Deliver what you proposed:\n${approach}`,
          deadlineAt: new Date(Date.now() + winner.delivery_minutes * 60_000).toISOString(),
          policy: { auctionId: auction.id, bidId: winner.id },
          title: `${winner.agent_name}: ${requestText}`,
        });
        await client.query(
          `UPDATE superagent_bids SET status = CASE WHEN id = $2 THEN 'won' ELSE 'lost' END
           WHERE auction_id = $1 AND status IN ('invited', 'submitted')`,
          [id, winner.id],
        );
        await client.query(
          `UPDATE superagent_auctions SET status='awarded', awarded_bid_id=$2, job_id=$3, updated_at=now()
           WHERE id=$1`,
          [id, winner.id, job.id],
        );
        if (input.fund && job.escrow_mode === "ledger") {
          await fundLedgerJob(client, job.id, userId);
          funded = true;
        }
        await audit(client, {
          actorId: userId,
          action: "superagent.auction_awarded",
          targetType: "superagent_auction",
          targetId: id,
          requestId: request.requestId,
          metadata: { bidId: winner.id, jobId: job.id, price: Number(winner.price), funded },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      response.json({
        data: {
          auction: await auctionView(await ownedAuction(id, userId)),
          job: { ...job, status: funded ? "funded" : job.status },
        },
      });
    }),
  );

  router.post(
    "/auctions/:id/cancel",
    requireSessionOrMobileAuth("mobile:approve"),
    asyncRoute(async (request, response) => {
      const id = z.string().uuid().parse(request.params.id);
      const userId = request.auth!.userId;
      const updated = await db.query(
        `UPDATE superagent_auctions SET status='cancelled', updated_at=now()
         WHERE id=$1 AND user_id=$2 AND status='open' RETURNING id`,
        [id, userId],
      );
      if (!updated.rowCount) {
        await ownedAuction(id, userId);
        throw new ApiError(
          409,
          "auction_closed",
          "Only an open request for bids can be cancelled.",
        );
      }
      await db.query(
        "UPDATE superagent_bids SET status='lost' WHERE auction_id=$1 AND status IN ('invited','submitted')",
        [id],
      );
      await audit(db, {
        actorId: userId,
        action: "superagent.auction_cancelled",
        targetType: "superagent_auction",
        targetId: id,
        requestId: request.requestId,
      });
      response.json({ data: await auctionView(await ownedAuction(id, userId)) });
    }),
  );

  // The invited agent reads what it is bidding on: the request, its own listing, and the limits.
  router.get(
    "/bids/:id",
    requireAuth,
    asyncRoute(async (request, response) => {
      const bid = await agentBid(
        request,
        z.string().uuid().parse(request.params.id),
        "briefs:read",
      );
      response.json({
        data: {
          id: bid.id,
          auctionId: bid.auction_id,
          status: bid.status,
          open: bid.auction_status === "open" && bid.closes_at > new Date(),
          request: decryptPayload(
            bid.request_ciphertext,
            payloadContext(bid.auction_id, "auction"),
          ),
          settlementAsset: bid.settlement_asset,
          maxBudget: bid.max_budget === null ? null : Number(bid.max_budget),
          closesAt: bid.closes_at,
          serviceSlug: bid.service_slug,
          listedPriceUsd: bid.listed_price_usd === null ? null : Number(bid.listed_price_usd),
          slaMinutes: bid.sla_minutes,
          maxPrice: selfSettlementLimit(bid.settlement_asset),
        },
      });
    }),
  );

  // One answer per invitation, before bidding closes: a price, a delivery time, and the approach,
  // or a decline.
  router.post(
    "/bids/:id",
    requireAuth,
    asyncRoute(async (request, response) => {
      const bidId = z.string().uuid().parse(request.params.id);
      const input = bidInput.parse(request.body);
      const bid = await agentBid(request, bidId, "deliverables:write");
      if (bid.auction_status !== "open" || bid.closes_at <= new Date())
        throw new ApiError(409, "bidding_closed", "Bidding on this request has closed.");
      if (bid.status !== "invited")
        throw new ApiError(409, "bid_already_answered", "This invitation was already answered.");
      if (!input.decline) {
        if (bid.max_budget !== null && input.price > Number(bid.max_budget))
          throw new ApiError(
            422,
            "over_budget",
            `The client's maximum budget is ${Number(bid.max_budget)} ${bid.settlement_asset.toUpperCase()}.`,
          );
        if (input.price >= selfSettlementLimit(bid.settlement_asset))
          throw new ApiError(
            422,
            "self_evaluation_limit",
            `Super Agent jobs must stay below ${selfSettlementLimit(bid.settlement_asset)} ${bid.settlement_asset.toUpperCase()}.`,
          );
      }
      const updated = await db.query(
        `UPDATE superagent_bids SET status=$2, price=$3, delivery_minutes=$4, approach_ciphertext=$5,
           submitted_at=now()
         WHERE id=$1 AND status='invited' RETURNING id`,
        input.decline
          ? [bidId, "declined", null, null, null]
          : [
              bidId,
              "submitted",
              String(input.price),
              input.deliveryMinutes,
              encryptPayload(input.approach, payloadContext(bidId, "bid")),
            ],
      );
      if (!updated.rowCount)
        throw new ApiError(409, "bid_already_answered", "This invitation was already answered.");
      await audit(db, {
        actorId: request.auth!.userId,
        action: input.decline ? "superagent.bid_declined" : "superagent.bid_submitted",
        targetType: "superagent_auction",
        targetId: bid.auction_id,
        requestId: request.requestId,
        metadata: {
          bidId,
          agentId: bid.agent_id,
          ...(input.decline ? {} : { price: input.price, deliveryMinutes: input.deliveryMinutes }),
        },
      });
      response
        .status(201)
        .json({ data: { id: bidId, status: input.decline ? "declined" : "submitted" } });
    }),
  );
}
