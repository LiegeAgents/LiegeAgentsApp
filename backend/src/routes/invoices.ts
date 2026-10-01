import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit.js";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";
import { transfer, userBalance } from "../ledger.js";
import { enqueueWebhookEvent } from "../webhooks.js";

const amount = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine(
    (value) => /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value) && Number(value) > 0,
    "Amount must be a positive USDG amount with at most six decimals.",
  );
const createInput = z.object({
  agentId: z.string().uuid(),
  description: z.string().trim().min(3).max(500),
  reference: z.string().trim().min(1).max(120).optional(),
  amountUsdg: amount,
  expiresAt: z.string().datetime(),
});
const id = z.string().uuid();

type InvoiceRow = {
  id: string;
  public_id: string;
  issuer_id: string;
  agent_id: string;
  description: string;
  reference: string | null;
  amount_usdg: string;
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
};
const publicInvoice = (row: InvoiceRow) => ({
  id: row.id,
  invoiceId: row.id,
  publicId: row.public_id,
  issuerId: row.issuer_id,
  agentId: row.agent_id,
  description: row.description,
  reference: row.reference,
  amountUsdg: Number(row.amount_usdg),
  asset: "usdg",
  status: row.status,
  expiresAt: row.expires_at,
  paidAt: row.paid_at,
  refundedAt: row.refunded_at,
  cancelledAt: row.cancelled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.issuer_wallet ? { issuerWallet: row.issuer_wallet } : {}),
  ...(row.payer_id ? { payerId: row.payer_id, payerWallet: row.payer_wallet } : {}),
});
const selectInvoice = `SELECT i.*, issuer.wallet_address AS issuer_wallet, p.payer_id, payer.wallet_address AS payer_wallet
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
      Number(input.amountUsdg) > Number(policy.rows[0].max_invoice_amount)
    )
      throw new ApiError(
        403,
        "policy_invoice_limit",
        "This invoice exceeds the agent's configured invoice limit.",
      );
    const result = await db.query<InvoiceRow>(
      `INSERT INTO invoices (id, issuer_id, agent_id, description, reference, amount_usdg, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        randomUUID(),
        request.auth!.userId,
        input.agentId,
        input.description,
        input.reference ?? null,
        input.amountUsdg,
        input.expiresAt,
      ],
    );
    const invoice = result.rows[0];
    await enqueueWebhookEvent(db, {
      invoiceId: invoice.id,
      eventType: "invoice.created",
      actorId: request.auth!.userId,
      data: { amountUsdg: Number(invoice.amount_usdg) },
    });
    await audit(db, {
      actorId: request.auth!.userId,
      action: "invoice.created",
      targetType: "invoice",
      targetId: invoice.id,
      requestId: request.requestId,
      metadata: { agentId: input.agentId, amountUsdg: input.amountUsdg },
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
  "/:id/payment",
  asyncRoute(async (request, response) => {
    const invoiceId = id.parse(request.params.id);
    const result = await db.query<InvoiceRow>(`${selectInvoice} WHERE i.id=$1`, [invoiceId]);
    if (!result.rowCount)
      throw new ApiError(404, "invoice_not_found", "This invoice is unavailable.");
    const invoice = await expireIfNeeded(result.rows[0]);
    response.json({
      data: {
        ...publicInvoice(invoice),
        payment: {
          method: "liege_ledger",
          asset: "usdg",
          amountUsdg: Number(invoice.amount_usdg),
          x402: "not_configured",
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
      const from = await userBalance(client, request.auth!.userId);
      const to = await userBalance(client, invoice.issuer_id);
      const transactionId = await transfer(client, {
        reference: `invoice-payment:${invoiceId}`,
        type: "invoice_payment",
        from: from.accountId,
        to: to.accountId,
        amount: invoice.amount_usdg,
        createdBy: request.auth!.userId,
        metadata: { invoiceId, issuerId: invoice.issuer_id, payerId: request.auth!.userId },
        insufficientFunds: new ApiError(
          422,
          "insufficient_available_balance",
          "Your available USDG balance cannot pay this invoice.",
        ),
      });
      await client.query(
        "INSERT INTO invoice_payments (invoice_id,payer_id,ledger_transaction_id,amount_usdg) VALUES ($1,$2,$3,$4)",
        [invoiceId, request.auth!.userId, transactionId, invoice.amount_usdg],
      );
      const paid = await client.query<InvoiceRow>(
        "UPDATE invoices SET status='paid', paid_at=now(), updated_at=now() WHERE id=$1 RETURNING *",
        [invoiceId],
      );
      await enqueueWebhookEvent(client, {
        invoiceId,
        eventType: "invoice.paid",
        actorId: request.auth!.userId,
        data: { amountUsdg: Number(invoice.amount_usdg), payerId: request.auth!.userId },
      });
      await audit(client, {
        actorId: request.auth!.userId,
        action: "invoice.paid",
        targetType: "invoice",
        targetId: invoiceId,
        requestId: request.requestId,
        metadata: { ledgerTransactionId: transactionId, amountUsdg: invoice.amount_usdg },
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
      if (invoice.status !== "paid" || !invoice.payer_id)
        throw new ApiError(
          409,
          "invoice_not_refundable",
          "Only a paid invoice can be refunded once.",
        );
      const from = await userBalance(client, invoice.issuer_id);
      const to = await userBalance(client, invoice.payer_id);
      const transactionId = await transfer(client, {
        reference: `invoice-refund:${invoiceId}`,
        type: "invoice_refund",
        from: from.accountId,
        to: to.accountId,
        amount: invoice.amount_usdg,
        createdBy: request.auth!.userId,
        metadata: { invoiceId, payerId: invoice.payer_id },
        insufficientFunds: new ApiError(
          422,
          "insufficient_available_balance",
          "Available USDG cannot cover this invoice refund.",
        ),
      });
      await client.query(
        "INSERT INTO invoice_refunds (invoice_id,payer_id,issuer_id,ledger_transaction_id,amount_usdg) VALUES ($1,$2,$3,$4,$5)",
        [invoiceId, invoice.payer_id, invoice.issuer_id, transactionId, invoice.amount_usdg],
      );
      const refunded = await client.query<InvoiceRow>(
        "UPDATE invoices SET status='refunded', refunded_at=now(), updated_at=now() WHERE id=$1 RETURNING *",
        [invoiceId],
      );
      await enqueueWebhookEvent(client, {
        invoiceId,
        eventType: "invoice.refunded",
        actorId: request.auth!.userId,
        data: { amountUsdg: Number(invoice.amount_usdg), payerId: invoice.payer_id },
      });
      await audit(client, {
        actorId: request.auth!.userId,
        action: "invoice.refunded",
        targetType: "invoice",
        targetId: invoiceId,
        requestId: request.requestId,
        metadata: { ledgerTransactionId: transactionId, amountUsdg: invoice.amount_usdg },
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
