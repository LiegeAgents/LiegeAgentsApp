import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  api,
  bearer,
  clearData,
  createAgent,
  credit,
  databaseAvailable,
  rebuildSchema,
  signIn,
} from "./support.js";

describe.skipIf(!databaseAvailable)("receipts and statement exports", () => {
  beforeAll(rebuildSchema);
  beforeEach(clearData);

  async function paidInvoice() {
    const [issuer, payer] = await Promise.all([signIn(), signIn()]);
    await credit(payer.userId, 20);
    const agentId = await createAgent(issuer);
    const invoice = await api()
      .post("/v1/invoices")
      .set(bearer(issuer))
      .send({
        agentId,
        description: '=HYPERLINK("https://example.com"), research',
        amountUsdg: "12.5",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      .expect(201);
    await api()
      .post(`/v1/invoices/${invoice.body.data.id}/pay`)
      .set(bearer(payer))
      .send({})
      .expect(200);
    return { issuer, payer, invoice: invoice.body.data as { id: string; publicId: string } };
  }

  test("lists itemized lines with their job or invoice and a stable digest", async () => {
    const { payer, invoice } = await paidInvoice();
    const statement = await api().get("/v1/receipts").set(bearer(payer)).expect(200);
    expect(statement.body.digest).toMatch(/^[0-9a-f]{64}$/);
    const [payment, deposit] = statement.body.data;
    expect(payment).toMatchObject({
      type: "invoice_payment",
      asset: "usdg",
      stakeChange: "0",
      subject: { type: "invoice", publicId: invoice.publicId, agentName: "Research Agent" },
    });
    expect(Number(payment.availableChange)).toBe(-12.5);
    expect(deposit.subject).toBeNull();

    const again = await api().get("/v1/receipts").set(bearer(payer)).expect(200);
    expect(again.body.digest).toBe(statement.body.digest);

    const receipt = await api()
      .get(`/v1/receipts/${payment.receiptId}`)
      .set(bearer(payer))
      .expect(200);
    expect(receipt.body.data.subject.publicId).toBe(invoice.publicId);
    expect(receipt.body.data.lines).toHaveLength(1);
    expect(receipt.body.data.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("exports CSV with neutralised formula cells", async () => {
    const { issuer } = await paidInvoice();
    const csv = await api().get("/v1/receipts?format=csv").set(bearer(issuer)).expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("liege-statement-");
    expect(csv.headers["x-liege-statement-digest"]).toMatch(/^[0-9a-f]{64}$/);
    const [header, row] = csv.text.trim().split("\r\n");
    expect(header.split(",")[0]).toBe("date");
    expect(row).toContain("invoice_payment");
    expect(row).toContain(`"'=HYPERLINK(""https://example.com""), research"`);
  });

  test("never shows another account's receipt", async () => {
    const { payer } = await paidInvoice();
    const outsider = await signIn();
    const statement = await api().get("/v1/receipts").set(bearer(payer)).expect(200);
    await api()
      .get(`/v1/receipts/${statement.body.data[0].receiptId}`)
      .set(bearer(outsider))
      .expect(404);
    const empty = await api().get("/v1/receipts").set(bearer(outsider)).expect(200);
    expect(empty.body.data).toEqual([]);
  });
});
