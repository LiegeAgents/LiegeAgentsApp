import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { canonical } from "../agentActions.js";
import { requireAuth } from "../auth.js";
import { db } from "../db/index.js";
import { ApiError, asyncRoute } from "../http.js";

type StatementRow = {
  id: string;
  reference: string;
  type: string;
  created_at: Date;
  asset: string;
  available_change: string;
  stake_change: string;
};

type Subject =
  | { type: "job"; id: string; publicId: string; title: string; agentName: string }
  | { type: "invoice"; id: string; publicId: string; title: string; agentName: string };

// Ledger references are `<kind>:<uuid>`; the kind prefix says whether the subject is a job or an invoice.
const subjectOf = (reference: string) => {
  const match = reference.match(/^(job|invoice)-[a-z-]+:([0-9a-f-]{36})$/);
  return match ? { type: match[1] as "job" | "invoice", id: match[2] } : null;
};

const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

async function statementRows(userId: string, options: { transactionId?: string; limit: number }) {
  const result = await db.query<StatementRow>(
    `SELECT lt.id, lt.reference, lt.type, lt.created_at, la.asset,
       COALESCE(sum(lp.amount) FILTER (WHERE la.kind = 'available'), 0) AS available_change,
       COALESCE(sum(lp.amount) FILTER (WHERE la.kind = 'stake'), 0) AS stake_change
     FROM ledger_transactions lt
     JOIN ledger_postings lp ON lp.transaction_id = lt.id
     JOIN ledger_accounts la ON la.id = lp.account_id
     WHERE la.user_id = $1 AND ($2::uuid IS NULL OR lt.id = $2::uuid)
     GROUP BY lt.id, la.asset
     ORDER BY lt.created_at DESC, lt.id
     LIMIT $3`,
    [userId, options.transactionId ?? null, options.limit],
  );
  return result.rows;
}

async function subjects(rows: StatementRow[]) {
  const ids = { job: new Set<string>(), invoice: new Set<string>() };
  for (const row of rows) {
    const subject = subjectOf(row.reference);
    if (subject) ids[subject.type].add(subject.id);
  }
  const found = new Map<string, Subject>();
  if (ids.job.size) {
    const jobs = await db.query(
      `SELECT j.id, j.public_id, j.title, a.name AS agent_name FROM jobs j JOIN agents a ON a.id = j.agent_id
       WHERE j.id = ANY($1::uuid[])`,
      [[...ids.job]],
    );
    for (const job of jobs.rows)
      found.set(job.id, {
        type: "job",
        id: job.id,
        publicId: job.public_id,
        title: job.title,
        agentName: job.agent_name,
      });
  }
  if (ids.invoice.size) {
    const invoices = await db.query(
      `SELECT i.id, i.public_id, i.description, a.name AS agent_name FROM invoices i JOIN agents a ON a.id = i.agent_id
       WHERE i.id = ANY($1::uuid[])`,
      [[...ids.invoice]],
    );
    for (const invoice of invoices.rows)
      found.set(invoice.id, {
        type: "invoice",
        id: invoice.id,
        publicId: invoice.public_id,
        title: invoice.description,
        agentName: invoice.agent_name,
      });
  }
  return found;
}

const line = (row: StatementRow, found: Map<string, Subject>) => ({
  receiptId: row.id,
  type: row.type,
  asset: row.asset,
  availableChange: String(row.available_change),
  stakeChange: String(row.stake_change),
  reference: row.reference,
  subject: found.get(subjectOf(row.reference)?.id ?? "") ?? null,
  createdAt: new Date(row.created_at).toISOString(),
});

// Spreadsheet apps execute cells that start with these characters, so text cells are neutralised.
const csvCell = (value: unknown, text = true) => {
  let cell = value == null ? "" : String(value);
  if (text && /^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
};

function formatOtel(
  items: Array<{
    receiptId: string;
    type: string;
    asset: string;
    availableChange: string;
    stakeChange: string;
    reference: string;
    subject: Subject | null;
    createdAt: string;
  }>,
  generatedAt: string,
  statementDigest: string,
) {
  const spans = items.map((item) => {
    const traceId = item.receiptId.replace(/-/g, "").toLowerCase().padEnd(32, "0").slice(0, 32);
    const spanId = createHash("sha256")
      .update(`${item.receiptId}:${item.asset}:${item.type}`)
      .digest("hex")
      .slice(0, 16);
    const timeUnixNano = (BigInt(new Date(item.createdAt).getTime()) * 1_000_000n).toString();

    const attributes: Array<{
      key: string;
      value: { stringValue?: string; doubleValue?: number; intValue?: number };
    }> = [
      { key: "ledger.receipt_id", value: { stringValue: item.receiptId } },
      { key: "ledger.transaction_type", value: { stringValue: item.type } },
      { key: "ledger.asset", value: { stringValue: item.asset } },
      { key: "ledger.available_change", value: { doubleValue: Number(item.availableChange) } },
      { key: "ledger.stake_change", value: { doubleValue: Number(item.stakeChange) } },
      { key: "ledger.reference", value: { stringValue: item.reference } },
      { key: "network.chain_id", value: { intValue: 4663 } },
      { key: "network.name", value: { stringValue: "robinhood_chain" } },
    ];

    if (item.subject) {
      attributes.push(
        { key: "ledger.subject_type", value: { stringValue: item.subject.type } },
        { key: "ledger.subject_id", value: { stringValue: item.subject.publicId } },
        { key: "ledger.subject_title", value: { stringValue: item.subject.title } },
        { key: "ledger.agent_name", value: { stringValue: item.subject.agentName } },
      );
    }

    return {
      traceId,
      spanId,
      name: `ledger.${item.type}`,
      kind: "SPAN_KIND_INTERNAL",
      startTimeUnixNano: timeUnixNano,
      endTimeUnixNano: timeUnixNano,
      attributes,
      status: { code: "STATUS_CODE_OK" },
    };
  });

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "liege" } },
            { key: "service.version", value: { stringValue: "0.1.7" } },
            { key: "network.chain_id", value: { intValue: 4663 } },
            { key: "network.name", value: { stringValue: "robinhood_chain" } },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "liege.ledger",
              version: "1.0.0",
            },
            spans,
          },
        ],
      },
    ],
    digest: statementDigest,
    generatedAt,
  };
}

export const receiptsRouter = Router();
receiptsRouter.use(requireAuth);

receiptsRouter.get(
  "/",
  asyncRoute(async (request, response) => {
    const query = z
      .object({
        format: z.enum(["json", "csv", "otel"]).default("json"),
        limit: z.coerce.number().int().min(1).max(5000).default(500),
      })
      .parse(request.query);
    const rows = await statementRows(request.auth!.userId, { limit: query.limit });
    const found = await subjects(rows);
    const lines = rows.map((row) => line(row, found));
    const generatedAt = new Date().toISOString();
    const statementDigest = digest(lines);
    const filename = `liege-statement-${generatedAt.slice(0, 10)}`;
    if (query.format === "csv") {
      const header = [
        "date",
        "receipt_id",
        "type",
        "asset",
        "available_change",
        "stake_change",
        "subject_type",
        "subject_id",
        "subject",
        "agent",
        "reference",
      ];
      const body = lines.map((item) =>
        [
          csvCell(item.createdAt),
          csvCell(item.receiptId),
          csvCell(item.type),
          csvCell(item.asset),
          csvCell(item.availableChange, false),
          csvCell(item.stakeChange, false),
          csvCell(item.subject?.type),
          csvCell(item.subject?.publicId),
          csvCell(item.subject?.title),
          csvCell(item.subject?.agentName),
          csvCell(item.reference),
        ].join(","),
      );
      response
        .type("text/csv")
        .set("Content-Disposition", `attachment; filename="${filename}.csv"`)
        .set("X-Liege-Statement-Digest", statementDigest)
        .send([header.join(","), ...body].join("\r\n") + "\r\n");
      return;
    }
    if (query.format === "otel") {
      const otelPayload = formatOtel(lines, generatedAt, statementDigest);
      response.type("application/json").set("X-Liege-Statement-Digest", statementDigest);
      if (request.query.download === "1") {
        response.set("Content-Disposition", `attachment; filename="${filename}.otel.json"`);
      }
      response.json(otelPayload);
      return;
    }
    if (request.query.download === "1")
      response.set("Content-Disposition", `attachment; filename="${filename}.json"`);
    response.json({ data: lines, digest: statementDigest, generatedAt });
  }),
);

receiptsRouter.get(
  "/:transactionId",
  asyncRoute(async (request, response) => {
    const transactionId = z.string().uuid().parse(request.params.transactionId);
    const rows = await statementRows(request.auth!.userId, { transactionId, limit: 10 });
    if (!rows.length)
      throw new ApiError(
        404,
        "receipt_not_found",
        "No receipt with this ID exists on your account.",
      );
    const found = await subjects(rows);
    const [first] = rows;
    const receipt = {
      receiptId: first.id,
      type: first.type,
      reference: first.reference,
      subject: found.get(subjectOf(first.reference)?.id ?? "") ?? null,
      lines: rows.map((row) => ({
        asset: row.asset,
        availableChange: String(row.available_change),
        stakeChange: String(row.stake_change),
      })),
      createdAt: new Date(first.created_at).toISOString(),
    };
    if (request.query.format === "otel") {
      const itemized = rows.map((row) => ({
        receiptId: first.id,
        type: first.type,
        asset: row.asset,
        availableChange: String(row.available_change),
        stakeChange: String(row.stake_change),
        reference: first.reference,
        subject: found.get(subjectOf(first.reference)?.id ?? "") ?? null,
        createdAt: new Date(first.created_at).toISOString(),
      }));
      const receiptDigest = digest(receipt);
      const otelPayload = formatOtel(itemized, receipt.createdAt, receiptDigest);
      response
        .type("application/json")
        .set("X-Liege-Statement-Digest", receiptDigest)
        .json(otelPayload);
      return;
    }
    response.json({ data: { ...receipt, digest: digest(receipt) } });
  }),
);
