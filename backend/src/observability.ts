import type { Pool, PoolClient } from "pg";

export type TraceEventType =
  "tool_call" | "runtime" | "retry" | "artifact" | "checkpoint" | "cost" | "outcome";

export type TraceMetadata = Record<string, string | number | boolean | null>;

export async function recordTrace(
  db: Pool | PoolClient,
  runId: string,
  eventType: TraceEventType,
  metadata: TraceMetadata,
) {
  await db.query(
    "INSERT INTO execution_trace_events (run_id, event_type, metadata) VALUES ($1,$2,$3)",
    [runId, eventType, JSON.stringify(metadata)],
  );
}
