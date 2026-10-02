import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  db,
  rebuildSchema,
  signIn,
} from "./support.js";

describe.skipIf(!databaseAvailable)("USDG invoices", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function issue(issuer: Awaited<ReturnType<typeof signIn>>) {
    const agentId = await createAgent(issuer);
    const response = await api()
      .post("/v1/invoices")
      .set(bearer(issuer))
      .send({
        agentId,
        description: "October research retainer",
        reference: "RET-001",
        amountUsdg: "12.5",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);
    return { agentId, invoice: response.body.data as { id: string; publicId: string } };
  }

  test("issues, pays, and refunds a USDG invoice exactly once", async () => {
    const [issuer, payer] = await Promise.all([signIn(), signIn()]);
    await credit(payer.userId, 20);
    const { invoice } = await issue(issuer);
    const paymentTerms = await api().get(`/v1/invoices/${invoice.id}/payment`).expect(200);
    expect(paymentTerms.body.data.payment).toMatchObject({
      asset: "usdg",
      amountUsdg: 12.5,
      x402: "not_configured",
    });
    await api().post(`/v1/invoices/${invoice.id}/pay`).set(bearer(payer)).send({}).expect(200);
    expect(await availableBalance(payer.userId)).toBe(7.5);
    expect(await availableBalance(issuer.userId)).toBe(12.5);
    await api().post(`/v1/invoices/${invoice.id}/refund`).set(bearer(issuer)).send({}).expect(200);
    await api().post(`/v1/invoices/${invoice.id}/refund`).set(bearer(issuer)).send({}).expect(409);
    expect(await availableBalance(payer.userId)).toBe(20);
    expect(await availableBalance(issuer.userId)).toBe(0);
  });

  test("concurrent payment attempts have one ledger effect", async () => {
    const [issuer, payer] = await Promise.all([signIn(), signIn()]);
    await credit(payer.userId, 20);
    const { invoice } = await issue(issuer);
    const responses = await Promise.all([
      api().post(`/v1/invoices/${invoice.id}/pay`).set(bearer(payer)).send({}),
      api().post(`/v1/invoices/${invoice.id}/pay`).set(bearer(payer)).send({}),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await availableBalance(payer.userId)).toBe(7.5);
    expect(await availableBalance(issuer.userId)).toBe(12.5);
  });

  test("enforces an agent invoice cap and emits expiry through the existing cron run", async () => {
    const issuer = await signIn();
    const agentId = await createAgent(issuer);
    await api()
      .put(`/v1/mcp/policies/${agentId}`)
      .set(bearer(issuer))
      .send({ maxInvoiceAmount: 10 })
      .expect(200);
    await api()
      .post("/v1/invoices")
      .set(bearer(issuer))
      .send({
        agentId,
        description: "Over the configured cap",
        amountUsdg: 10.000001,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(403);
    const issued = await api()
      .post("/v1/invoices")
      .set(bearer(issuer))
      .send({
        agentId,
        description: "At the configured cap",
        amountUsdg: 10,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);
    // Preserve the database invariant expires_at > created_at while making the invoice due.
    await db.query(
      "UPDATE invoices SET created_at=now() - interval '2 seconds', expires_at=now() - interval '1 second' WHERE id=$1",
      [issued.body.data.id],
    );
    const cron = await api()
      .post("/v1/cron/expire-jobs")
      .set({ "x-cron-secret": process.env.CRON_SECRET! })
      .send({ idempotencyKey: "invoice-expiry-test" })
      .expect(200);
    expect(cron.body.invoicesExpired).toBe(1);
    const event = await db.query<{ event_type: string }>(
      "SELECT event_type FROM webhook_events WHERE invoice_id=$1",
      [issued.body.data.id],
    );
    expect(event.rows.map((row) => row.event_type)).toContain("invoice.expired");
  });

  test("supports partial refunds bound to jobId and reason with audit trail", async () => {
    const [issuer, payer] = await Promise.all([signIn(), signIn()]);
    await credit(payer.userId, 20);
    const { invoice } = await issue(issuer);
    await api().post(`/v1/invoices/${invoice.id}/pay`).set(bearer(payer)).send({}).expect(200);

    // First partial refund: 5 USDG with reason
    const partial1 = await api()
      .post(`/v1/invoices/${invoice.id}/refund`)
      .set(bearer(issuer))
      .send({ amount: 5, reason: "First milestone adjusted" })
      .expect(200);
    expect(partial1.body.data.status).toBe("partially_refunded");
    expect(partial1.body.data.refundedAmount).toBe(5);
    expect(partial1.body.data.remainingAmount).toBe(7.5);
    expect(await availableBalance(payer.userId)).toBe(12.5);
    expect(await availableBalance(issuer.userId)).toBe(7.5);

    // Second partial refund: cannot exceed remaining (e.g. 10 USDG when remaining is 7.5)
    await api()
      .post(`/v1/invoices/${invoice.id}/refund`)
      .set(bearer(issuer))
      .send({ amount: 10 })
      .expect(422);

    // Second partial refund: 7.5 USDG (completing the refund)
    const partial2 = await api()
      .post(`/v1/invoices/${invoice.id}/refund`)
      .set(bearer(issuer))
      .send({ amount: 7.5, reason: "Final balance settled" })
      .expect(200);
    expect(partial2.body.data.status).toBe("refunded");
    expect(partial2.body.data.refundedAmount).toBe(12.5);
    expect(partial2.body.data.remainingAmount).toBe(0);
    expect(await availableBalance(payer.userId)).toBe(20);
    expect(await availableBalance(issuer.userId)).toBe(0);

    // Third refund should fail with 409
    await api()
      .post(`/v1/invoices/${invoice.id}/refund`)
      .set(bearer(issuer))
      .send({ amount: 1 })
      .expect(409);

    // Check GET /v1/invoices/:id/refunds
    const refundsList = await api()
      .get(`/v1/invoices/${invoice.id}/refunds`)
      .set(bearer(issuer))
      .expect(200);
    expect(refundsList.body.data.length).toBe(2);
    expect(refundsList.body.data[0].amount).toBe(5);
    expect(refundsList.body.data[0].reason).toBe("First milestone adjusted");
    expect(refundsList.body.data[1].amount).toBe(7.5);
    expect(refundsList.body.data[1].reason).toBe("Final balance settled");
  });
});
