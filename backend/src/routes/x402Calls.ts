import { createHash, randomUUID } from "node:crypto";
import { Router, type Response } from "express";
import { z } from "zod";
import { encryptPayload, payloadContext } from "../crypto.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { readyEnrollment } from "../superAgentEnrollment.js";
import { dispatch, finishCall, MAX_CALL_INPUT, type Target } from "../superAgentCalls.js";
import {
  decodePaymentSignature,
  encodePaymentRequired,
  encodeSettlementResponse,
  paymentRequired,
  settlePayment,
  verifyPayment,
  x402Configured,
  type X402PaymentRequired,
} from "../x402.js";

/**
 * Instant calls for any wallet over x402, with no Liege account. The caller signs a USDG transfer
 * to the agent owner's wallet; Liege verifies it, calls the agent, and settles the transfer only
 * when the agent answered with a valid proof. A failed call is never settled, so it costs nothing.
 */
export const x402CallsRouter = Router();

type X402Target = Target & { owner_wallet: string; agent_name: string };

async function findTarget(agentId: string) {
  const found = await db.query<X402Target>(
    `SELECT a.owner_id, a.name AS agent_name, u.wallet_address AS owner_wallet,
       s.slug AS service_slug, w.id AS webhook_id, w.url, w.secret_ciphertext,
       trim_scale(e.call_price_usdg)::text AS price, e.settlement_assets AS assets
     FROM agents a ${readyEnrollment} JOIN users u ON u.id = a.owner_id
     WHERE a.id = $1 AND a.active AND e.enabled AND e.verified_at IS NOT NULL`,
    [agentId],
  );
  const target = found.rows[0];
  if (!target)
    throw new ApiError(
      404,
      "call_agent_unavailable",
      "That agent is not an available Super Agent.",
    );
  if (!target.price || !target.assets.includes("usdg"))
    throw new ApiError(
      422,
      "instant_calls_not_offered",
      "This agent does not take instant calls paid in USDG.",
    );
  return target;
}

const refuse = (response: Response, terms: X402PaymentRequired, error: string) =>
  response
    .status(402)
    .set("PAYMENT-REQUIRED", encodePaymentRequired(terms))
    .json({ ...terms, error });

x402CallsRouter.post(
  "/calls/:agentId",
  asyncRoute(async (request, response) => {
    if (!x402Configured())
      throw new ApiError(501, "x402_not_configured", "x402 payment settlement is not configured.");
    const agentId = z.string().uuid().parse(request.params.agentId);
    const { input } = z
      .object({ input: z.string().trim().min(1).max(MAX_CALL_INPUT) })
      .parse(request.body);
    const target = await findTarget(agentId);
    const resourceUrl = `${request.protocol}://${request.get("host")}${request.originalUrl.split("?")[0]}`;
    // The terms depend only on the agent and its price, so a signed payment can be prepared once.
    const terms = paymentRequired(
      {
        id: agentId,
        description: `One instant call to ${target.agent_name}`,
        amount_usdg: target.price!,
        expires_at: new Date(),
        issuer_wallet: target.owner_wallet,
      },
      resourceUrl,
    );
    const signature = request.header("payment-signature") ?? request.header("x-payment");
    if (!signature) return refuse(response, terms, "PAYMENT-SIGNATURE header is required");
    let payload: Record<string, unknown>;
    try {
      payload = decodePaymentSignature(signature);
    } catch (error) {
      return refuse(response, terms, error instanceof Error ? error.message : "Invalid payment.");
    }
    const verification = await verifyPayment(payload, terms.accepts[0]);
    if (!verification.isValid || !verification.payer)
      return refuse(
        response,
        terms,
        verification.invalidReason ?? "Payment authorization was rejected.",
      );
    const payerWallet = verification.payer.toLowerCase();
    if (payerWallet === target.owner_wallet.toLowerCase())
      throw new ApiError(422, "self_hire_not_allowed", "An owner cannot hire their own agent.");

    // Record the call before any work: the unique payment hash stops one signed payment from
    // buying two calls when it is sent twice at once.
    const id = randomUUID();
    // Keyed on the EIP-3009 authorization (payer and nonce) so re-encoding the same signed
    // payment does not get past it.
    const authorization = (payload.payload as { authorization?: { from?: string; nonce?: string } })
      ?.authorization;
    const paymentHash = createHash("sha256")
      .update(
        authorization?.nonce
          ? `${String(authorization.from).toLowerCase()}:${authorization.nonce.toLowerCase()}`
          : signature,
      )
      .digest("hex");
    const payer = await db.query<{ id: string }>("SELECT id FROM users WHERE wallet_address = $1", [
      payerWallet,
    ]);
    const inserted = await db.query(
      `INSERT INTO superagent_calls
         (id, client_id, agent_id, service_slug, settlement_asset, price, input_ciphertext,
          payment_method, payer_wallet, payment_hash)
       VALUES ($1,$2,$3,$4,'usdg',$5,$6,'x402',$7,$8) ON CONFLICT (payment_hash) DO NOTHING`,
      [
        id,
        payer.rows[0]?.id ?? null,
        agentId,
        target.service_slug,
        target.price,
        encryptPayload(input, payloadContext(id, "call-input")),
        payerWallet,
        paymentHash,
      ],
    );
    if (!inserted.rowCount)
      throw new ApiError(409, "payment_already_used", "This payment was already used for a call.");

    const started = Date.now();
    const outcome = await dispatch(id, agentId, input, target);
    if (outcome.status === "refunded") {
      await finishCall(id, outcome, Date.now() - started);
      return response.status(502).json({
        error: {
          code: "call_failed",
          message: `${outcome.error} Your payment was not settled, so you were not charged.`,
        },
        data: { id, status: "refunded", charged: false },
      });
    }
    let settlement: Awaited<ReturnType<typeof settlePayment>>;
    try {
      settlement = await settlePayment(payload, terms.accepts[0]);
    } catch (error) {
      settlement = {
        success: false,
        errorReason: error instanceof Error ? error.message : "Settlement failed.",
      };
    }
    if (
      !settlement.success ||
      !settlement.transaction ||
      settlement.network !== terms.accepts[0].network ||
      (settlement.payer && settlement.payer.toLowerCase() !== payerWallet)
    ) {
      // Unpaid work is not handed over.
      await finishCall(
        id,
        {
          status: "refunded",
          error: `Payment settlement failed (${settlement.errorReason ?? "no transaction"}), so the answer was withheld.`,
        },
        Date.now() - started,
      );
      return refuse(response, terms, settlement.errorReason ?? "Payment settlement failed.");
    }
    await finishCall(id, outcome, Date.now() - started, {
      transaction: settlement.transaction,
      network: settlement.network!,
    });
    response
      .status(200)
      .set("PAYMENT-RESPONSE", encodeSettlementResponse(settlement))
      .json({
        data: {
          id,
          agentId,
          agentName: target.agent_name,
          status: "succeeded",
          charged: true,
          price: target.price,
          settlementAsset: "usdg",
          payerWallet,
          settlementTransaction: settlement.transaction,
          settlementNetwork: settlement.network,
          output: outcome.output,
          durationMs: Date.now() - started,
        },
      });
  }),
);
