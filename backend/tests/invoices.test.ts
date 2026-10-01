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
    await db.query("UPDATE invoices SET expires_at=now() - interval '1 second' WHERE id=$1", [
      issued.body.data.id,
    ]);
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
});
