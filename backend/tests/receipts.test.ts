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

  test("exports OpenTelemetry compliant traces and spans with stable digests", async () => {
    const { issuer, invoice } = await paidInvoice();
    const otel = await api().get("/v1/receipts?format=otel").set(bearer(issuer)).expect(200);
    expect(otel.headers["content-type"]).toContain("application/json");
    expect(otel.headers["x-liege-statement-digest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(otel.body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(otel.body.resourceSpans).toBeArray();
    expect(otel.body.resourceSpans.length).toBeGreaterThan(0);

    const resourceSpan = otel.body.resourceSpans[0];
    expect(resourceSpan.resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "liege" } },
        { key: "network.chain_id", value: { intValue: 4663 } },
      ]),
    );

    const spans = resourceSpan.scopeSpans[0].spans;
    expect(spans.length).toBeGreaterThan(0);
    const [span] = spans;
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.name).toBe("ledger.invoice_payment");
    expect(span.kind).toBe("SPAN_KIND_INTERNAL");
    expect(span.attributes).toEqual(
      expect.arrayContaining([
        { key: "ledger.transaction_type", value: { stringValue: "invoice_payment" } },
        { key: "ledger.asset", value: { stringValue: "usdg" } },
        { key: "ledger.subject_id", value: { stringValue: invoice.publicId } },
      ]),
    );

    const receiptIdAttr = span.attributes.find((a: any) => a.key === "ledger.receipt_id");
    const receiptOtel = await api()
      .get(`/v1/receipts/${receiptIdAttr.value.stringValue}?format=otel`)
      .set(bearer(issuer))
      .expect(200);
    expect(receiptOtel.body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
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
