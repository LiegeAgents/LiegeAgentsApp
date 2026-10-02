import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { transfer, userBalance } from "../ledger.js";
import { enqueueWebhookEvent } from "../webhooks.js";
import { ASSET_DECIMALS, assetLabel, type SettlementAsset } from "../assets.js";
import {
  decodePaymentSignature,
  encodePaymentRequired,
  encodeSettlementResponse,
  paymentRequired,
  settlePayment,
  verifyPayment,
  x402Configured,
} from "../x402.js";

const createInput = z
  .object({
    agentId: z.string().uuid(),
    description: z.string().trim().min(3).max(500),
    reference: z.string().trim().min(1).max(120).optional(),
    asset: z.enum(["usdg", "liege"]).default("usdg"),
    amount: z.union([z.string(), z.number().finite()]).optional(),
    amountUsdg: z.union([z.string(), z.number().finite()]).optional(),
    expiresAt: z.string().datetime(),
  })
  .superRefine((val, ctx) => {
    const raw = val.amount ?? val.amountUsdg;
    if (raw == null) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: "amount is required.",
      });
      return;
    }
    const str = typeof raw === "number" ? String(raw) : String(raw).trim();
    const decimals = ASSET_DECIMALS[val.asset];
    const regex = new RegExp(`^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${decimals}})?$`);
    if (!regex.test(str) || Number(str) <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: `Amount must be a positive decimal with at most ${decimals} decimals for ${assetLabel(val.asset)}.`,
      });
    }
  });
const id = z.string().uuid();

type InvoiceRow = {
  id: string;
  public_id: string;
  issuer_id: string;
  agent_id: string;
  description: string;
  reference: string | null;
  amount: string;
  amount_usdg: string | null;
  asset: SettlementAsset;
  status: string;
  expires_at: Date;
  paid_at: Date | null;
  refunded_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  issuer_wallet?: string;
  payer_id?: string | null;
  payer_wallet?: string | null;
  payment_method?: string;
  settlement_transaction?: string | null;
  settlement_network?: string | null;
};
const publicInvoice = (row: InvoiceRow) => {
  const asset = (row.asset ?? "usdg") as SettlementAsset;
  const numAmount = Number(row.amount ?? row.amount_usdg ?? 0);
  return {
    id: row.id,
    invoiceId: row.id,
    publicId: row.public_id,
    issuerId: row.issuer_id,
    agentId: row.agent_id,
    description: row.description,
    reference: row.reference,
    amount: numAmount,
    amountUsdg:
      asset === "usdg" ? numAmount : row.amount_usdg != null ? Number(row.amount_usdg) : numAmount,
    asset,
    status: row.status,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.issuer_wallet ? { issuerWallet: row.issuer_wallet } : {}),
    ...(row.payer_id || row.payer_wallet
      ? {
          ...(row.payer_id ? { payerId: row.payer_id } : {}),
          ...(row.payer_wallet ? { payerWallet: row.payer_wallet } : {}),
        }
      : {}),
    ...(row.payment_method
      ? {
          paymentMethod: row.payment_method,
          ...(row.settlement_transaction
            ? { settlementTransaction: row.settlement_transaction }
            : {}),
          ...(row.settlement_network ? { settlementNetwork: row.settlement_network } : {}),
        }
      : {}),
  };
};
const selectInvoice = `SELECT i.*, issuer.wallet_address AS issuer_wallet, p.payer_id, payer.wallet_address AS payer_wallet,
  p.payment_method, p.settlement_transaction, p.settlement_network
  FROM invoices i JOIN users issuer ON issuer.id=i.issuer_id
  LEFT JOIN invoice_payments p ON p.invoice_id=i.id LEFT JOIN users payer ON payer.id=p.payer_id`;

async function expireIfNeeded(invoice: InvoiceRow) {
  if (invoice.status !== "issued" || new Date(invoice.expires_at) > new Date()) return invoice;
  // The protected expiry cron records the durable state transition and event. A read must not
  // mutate the invoice independently, otherwise a consumer could miss invoice.expired.
  return { ...invoice, status: "expired" };
}

export const invoicesRouter = Router();

invoicesRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const input = createInput.parse(request.body);
    const invoiceAmount =
      typeof (input.amount ?? input.amountUsdg) === "number"
        ? String(input.amount ?? input.amountUsdg)
        : String(input.amount ?? input.amountUsdg).trim();
    if (new Date(input.expiresAt) <= new Date())
      throw new ApiError(422, "invalid_expiry", "Invoice expiry must be in the future.");
    const agent = await db.query("SELECT id FROM agents WHERE id=$1 AND owner_id=$2", [
      input.agentId,
      request.auth!.userId,
    ]);
    if (!agent.rowCount)
      throw new ApiError(404, "agent_not_found", "This agent is not owned by your account.");
    const policy = await db.query<{ max_invoice_amount: string | null }>(
      "SELECT max_invoice_amount FROM agent_approval_policies WHERE agent_id=$1",
      [input.agentId],
    );
    if (
      policy.rows[0]?.max_invoice_amount != null &&
      Number(invoiceAmount) > Number(policy.rows[0].max_invoice_amount)
    )
      throw new ApiError(
        403,
        "policy_invoice_limit",
        "This invoice exceeds the agent's configured invoice limit.",
      );
    const result = await db.query<InvoiceRow>(
      `INSERT INTO invoices (id, issuer_id, agent_id, description, reference, amount, amount_usdg, asset, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        randomUUID(),
        request.auth!.userId,
        input.agentId,
        input.description,
        input.reference ?? null,
        invoiceAmount,
        input.asset === "usdg" ? invoiceAmount : null,
        input.asset,
        input.expiresAt,
      ],
    );
    const invoice = result.rows[0];
    await enqueueWebhookEvent(db, {
      invoiceId: invoice.id,
      eventType: "invoice.created",
      actorId: request.auth!.userId,
      data: {
        amount: Number(invoice.amount ?? invoice.amount_usdg),
        amountUsdg: Number(invoice.amount_usdg ?? invoice.amount),
        asset: invoice.asset,
      },
    });
    await audit(db, {
      actorId: request.auth!.userId,
      action: "invoice.created",
      targetType: "invoice",
      targetId: invoice.id,
      requestId: request.requestId,
      metadata: { agentId: input.agentId, amount: invoiceAmount, asset: input.asset },
    });
    response.status(201).json({ data: publicInvoice(invoice) });
  }),
);

invoicesRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (request, response) => {
    const result = await db.query<InvoiceRow>(
      `${selectInvoice} WHERE i.issuer_id=$1 OR p.payer_id=$1 ORDER BY i.created_at DESC LIMIT 100`,
      [request.auth!.userId],
    );
    response.json({ data: result.rows.map(publicInvoice) });
  }),
);

invoicesRouter.get(
  "/:id/x402",
  asyncRoute(async (request, response) => {
    if (!x402Configured())
      throw new ApiError(501, "x402_not_configured", "x402 payment settlement is not configured.");
    const invoiceId = id.parse(request.params.id);
    const resourceUrl = `${request.protocol}://${request.get("host")}${request.originalUrl.split("?")[0]}`;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<InvoiceRow>(
        `${selectInvoice} WHERE i.id=$1 FOR UPDATE OF i`,
        [invoiceId],
      );
      if (!result.rowCount)
        throw new ApiError(404, "invoice_not_found", "This invoice is unavailable.");
      const invoice = result.rows[0];
      if (invoice.status === "paid") {
        await client.query("COMMIT");
        return response.json({ data: publicInvoice(invoice) });
      }
      if (invoice.status !== "issued")
        throw new ApiError(409, "invoice_unavailable", "This invoice cannot be paid.");
      if (new Date(invoice.expires_at) <= new Date())
        throw new ApiError(409, "invoice_expired", "This invoice has expired.");
      if (invoice.asset && invoice.asset !== "usdg")
        throw new ApiError(
          501,
          "x402_asset_unsupported",
          "x402 settlement currently supports USDG only.",
        );
      const terms = paymentRequired(
        {
          ...invoice,
          amount_usdg: invoice.amount_usdg ?? invoice.amount,
        },
        resourceUrl,
      );
      const encodedTerms = encodePaymentRequired(terms);
      const signature = request.header("payment-signature") ?? request.header("x-payment");
      if (!signature) {
        await client.query("ROLLBACK");
        return response
          .status(402)
          .set("PAYMENT-REQUIRED", encodedTerms)
          .json({ ...terms, error: "PAYMENT-SIGNATURE header is required" });
      }
      let payload: Record<string, unknown>;
      try {
        payload = decodePaymentSignature(signature);
      } catch (error) {
        await client.query("ROLLBACK");
        return response
          .status(402)
          .set("PAYMENT-REQUIRED", encodedTerms)
          .json({
            error: error instanceof Error ? error.message : "Invalid payment signature.",
            ...terms,
          });
      }
      const verification = await verifyPayment(payload, terms.accepts[0]);
      if (!verification.isValid || !verification.payer) {
        await client.query("ROLLBACK");
        return response
          .status(402)
          .set("PAYMENT-REQUIRED", encodedTerms)
          .json({
            error: verification.invalidReason ?? "Payment authorization was rejected.",
            ...terms,
          });
      }
      const settlement = await settlePayment(payload, terms.accepts[0]);
      if (!settlement.success || !settlement.transaction || !settlement.network) {
        await client.query("ROLLBACK");
        return response
          .status(402)
          .set("PAYMENT-REQUIRED", encodedTerms)
          .json({
            error: settlement.errorReason ?? "Payment settlement failed.",
            ...terms,
          });
      }
      if (
        settlement.network !== terms.accepts[0].network ||
        (settlement.payer && settlement.payer.toLowerCase() !== verification.payer.toLowerCase())
      ) {
        await client.query("ROLLBACK");
        throw new ApiError(
          502,
          "x402_facilitator_mismatch",
          "The facilitator returned a settlement for a different network or payer.",
        );
      }
      const payerWallet = verification.payer.toLowerCase();
      const payer = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE lower(wallet_address)=lower($1)",
        [payerWallet],
      );
      const payerId = payer.rows[0]?.id ?? null;
      await client.query(
        `INSERT INTO invoice_payments
          (invoice_id,payer_id,ledger_transaction_id,amount_usdg,payment_method,payer_wallet,settlement_transaction,settlement_network)
         VALUES ($1,$2,NULL,$3,'x402',$4,$5,$6)`,
        [
          invoiceId,
          payerId,
          invoice.amount_usdg,
          payerWallet,
          settlement.transaction,
          settlement.network,
        ],
      );
      const paid = await client.query<InvoiceRow>(
        "UPDATE invoices SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1 RETURNING *",
        [invoiceId],
      );
      await enqueueWebhookEvent(client, {
        invoiceId,
        eventType: "invoice.paid",
        actorId: payerId ?? undefined,
        data: {
          amountUsdg: Number(invoice.amount_usdg),
          paymentMethod: "x402",
          payerWallet,
          settlementTransaction: settlement.transaction,
          settlementNetwork: settlement.network,
        },
      });
      await audit(client, {
        actorId: payerId ?? undefined,
        action: "invoice.paid",
        targetType: "invoice",
        targetId: invoiceId,
        requestId: request.requestId,
        metadata: {
          paymentMethod: "x402",
          payerWallet,
          settlementTransaction: settlement.transaction,
          settlementNetwork: settlement.network,
        },
      });
      await client.query("COMMIT");
      return response.set("PAYMENT-RESPONSE", encodeSettlementResponse(settlement)).json({
        data: publicInvoice({
          ...paid.rows[0],
          payer_id: payerId,
          payer_wallet: payerWallet,
          payment_method: "x402",
          settlement_transaction: settlement.transaction,
          settlement_network: settlement.network,
        }),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

invoicesRouter.get(
  "/:id/payment",
  asyncRoute(async (request, response) => {
    const invoiceId = id.parse(request.params.id);
    const result = await db.query<InvoiceRow>(`${selectInvoice} WHERE i.id=$1`, [invoiceId]);
    if (!result.rowCount)
      throw new ApiError(404, "invoice_not_found", "This invoice is unavailable.");
    const invoice = await expireIfNeeded(result.rows[0]);
    const asset = (invoice.asset ?? "usdg") as SettlementAsset;
    const invoiceAmount = Number(invoice.amount ?? invoice.amount_usdg);
    response.json({
      data: {
        ...publicInvoice(invoice),
        payment: {
          method: "liege_ledger",
          asset,
          amount: invoiceAmount,
          amountUsdg:
            asset === "usdg"
              ? invoiceAmount
              : invoice.amount_usdg != null
                ? Number(invoice.amount_usdg)
                : invoiceAmount,
          x402: asset === "usdg" && x402Configured() ? "available" : "not_configured",
          ...(asset === "usdg" && x402Configured()
            ? { endpoint: `/v1/invoices/${invoice.id}/x402` }
            : {}),
        },
      },
    });
  }),
);

invoicesRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (request, response) => {
    const invoiceId = id.parse(request.params.id);
    const result = await db.query<InvoiceRow>(
      `${selectInvoice} WHERE i.id=$1 AND (i.issuer_id=$2 OR p.payer_id=$2)`,
      [invoiceId, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(404, "invoice_not_found", "This invoice is unavailable.");
    response.json({ data: publicInvoice(await expireIfNeeded(result.rows[0])) });
  }),
);

invoicesRouter.post(
  "/:id/pay",
  requireAuth,
  asyncRoute(async (request, response) => {
    const invoiceId = id.parse(request.params.id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<InvoiceRow>(
        `${selectInvoice} WHERE i.id=$1 FOR UPDATE OF i`,
        [invoiceId],
      );
      if (!result.rowCount)
        throw new ApiError(404, "invoice_not_found", "This invoice is unavailable.");
      const invoice = result.rows[0];
      if (invoice.status !== "issued")
        throw new ApiError(409, "invoice_unavailable", "This invoice cannot be paid.");
      if (new Date(invoice.expires_at) <= new Date())
        throw new ApiError(409, "invoice_expired", "This invoice has expired.");
      if (invoice.issuer_id === request.auth!.userId)
        throw new ApiError(422, "self_payment", "The invoice issuer cannot pay their own invoice.");
      const asset = (invoice.asset ?? "usdg") as SettlementAsset;
      const invoiceAmount = invoice.amount ?? invoice.amount_usdg ?? "0";
      const from = await userBalance(client, request.auth!.userId, "available", asset);
      const to = await userBalance(client, invoice.issuer_id, "available", asset);
      const transactionId = await transfer(client, {
        reference: `invoice-payment:${invoiceId}`,
        type: "invoice_payment",
        from: from.accountId,
        to: to.accountId,
        amount: invoiceAmount,
        asset,
        createdBy: request.auth!.userId,
        metadata: { invoiceId, issuerId: invoice.issuer_id, payerId: request.auth!.userId, asset },
        insufficientFunds: new ApiError(
          422,
          "insufficient_available_balance",
          `Your available ${assetLabel(asset)} balance cannot pay this invoice.`,
        ),
      });
      await client.query(
        "INSERT INTO invoice_payments (invoice_id,payer_id,ledger_transaction_id,amount,amount_usdg,asset) VALUES ($1,$2,$3,$4,$5,$6)",
        [
          invoiceId,
          request.auth!.userId,
          transactionId,
          invoiceAmount,
          asset === "usdg" ? invoiceAmount : null,
          asset,
        ],
      );
      const paid = await client.query<InvoiceRow>(
        "UPDATE invoices SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1 RETURNING *",
        [invoiceId],
      );
      await enqueueWebhookEvent(client, {
        invoiceId,
        eventType: "invoice.paid",
        actorId: request.auth!.userId,
        data: {
          amount: Number(invoiceAmount),
          amountUsdg: Number(invoice.amount_usdg ?? invoiceAmount),
          asset,
          payerId: request.auth!.userId,
        },
      });
      await audit(client, {
        actorId: request.auth!.userId,
        action: "invoice.paid",
        targetType: "invoice",
        targetId: invoiceId,
        requestId: request.requestId,
        metadata: { ledgerTransactionId: transactionId, amount: invoiceAmount, asset },
      });
      await client.query("COMMIT");
      response.json({ data: publicInvoice({ ...paid.rows[0], payer_id: request.auth!.userId }) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

invoicesRouter.post(
  "/:id/refund",
  requireAuth,
  asyncRoute(async (request, response) => {
    const invoiceId = id.parse(request.params.id);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<InvoiceRow>(
        `${selectInvoice} WHERE i.id=$1 AND i.issuer_id=$2 FOR UPDATE OF i`,
        [invoiceId, request.auth!.userId],
      );
      if (!result.rowCount)
        throw new ApiError(404, "invoice_not_found", "This invoice is unavailable.");
      const invoice = result.rows[0];
      if (invoice.payment_method === "x402")
        throw new ApiError(
          501,
          "x402_refund_not_configured",
          "Refunds for on-chain x402 payments are not configured yet.",
        );
      if (invoice.status !== "paid" || !invoice.payer_id)
        throw new ApiError(
          409,
          "invoice_not_refundable",
          "Only a paid invoice can be refunded once.",
        );
      const asset = (invoice.asset ?? "usdg") as SettlementAsset;
      const invoiceAmount = invoice.amount ?? invoice.amount_usdg ?? "0";
      const from = await userBalance(client, invoice.issuer_id, "available", asset);
      const to = await userBalance(client, invoice.payer_id, "available", asset);
      const transactionId = await transfer(client, {
        reference: `invoice-refund:${invoiceId}`,
        type: "invoice_refund",
        from: from.accountId,
        to: to.accountId,
        amount: invoiceAmount,
        asset,
        createdBy: request.auth!.userId,
        metadata: { invoiceId, payerId: invoice.payer_id, asset },
        insufficientFunds: new ApiError(
          422,
          "insufficient_available_balance",
          `Available ${assetLabel(asset)} cannot cover this invoice refund.`,
        ),
      });
      await client.query(
        "INSERT INTO invoice_refunds (invoice_id,payer_id,issuer_id,ledger_transaction_id,amount,amount_usdg,asset) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          invoiceId,
          invoice.payer_id,
          invoice.issuer_id,
          transactionId,
          invoiceAmount,
          asset === "usdg" ? invoiceAmount : null,
          asset,
        ],
      );
      const refunded = await client.query<InvoiceRow>(
        "UPDATE invoices SET status='refunded', refunded_at=now(), updated_at=now() WHERE id=$1 RETURNING *",
        [invoiceId],
      );
      await enqueueWebhookEvent(client, {
        invoiceId,
        eventType: "invoice.refunded",
        actorId: request.auth!.userId,
        data: {
          amount: Number(invoiceAmount),
          amountUsdg: Number(invoice.amount_usdg ?? invoiceAmount),
          asset,
          payerId: invoice.payer_id,
        },
      });
      await audit(client, {
        actorId: request.auth!.userId,
        action: "invoice.refunded",
        targetType: "invoice",
        targetId: invoiceId,
        requestId: request.requestId,
        metadata: { ledgerTransactionId: transactionId, amount: invoiceAmount, asset },
      });
      await client.query("COMMIT");
      response.json({ data: publicInvoice({ ...refunded.rows[0], payer_id: invoice.payer_id }) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

invoicesRouter.post(
  "/:id/cancel",
  requireAuth,
  asyncRoute(async (request, response) => {
    const invoiceId = id.parse(request.params.id);
    const result = await db.query<InvoiceRow>(
      "UPDATE invoices SET status='cancelled', cancelled_at=now(), updated_at=now() WHERE id=$1 AND issuer_id=$2 AND status='issued' RETURNING *",
      [invoiceId, request.auth!.userId],
    );
    if (!result.rowCount)
      throw new ApiError(409, "invoice_unavailable", "Only an issued invoice can be cancelled.");
    await enqueueWebhookEvent(db, {
      invoiceId,
      eventType: "invoice.cancelled",
      actorId: request.auth!.userId,
    });
    await audit(db, {
      actorId: request.auth!.userId,
      action: "invoice.cancelled",
      targetType: "invoice",
      targetId: invoiceId,
      requestId: request.requestId,
    });
    response.json({ data: publicInvoice(result.rows[0]) });
  }),
);
