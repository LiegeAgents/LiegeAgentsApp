import { config } from "./config.js";
import type { JobAttachment } from "./attachments.js";
import type { BidAnswer, BidInvitation } from "./bidding.js";
import type { LiegeJob } from "./types.js";

const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${config.apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.runtimeToken}`,
      "x-liege-runtime-token": "1",
      accept: "application/json",
      ...init.headers,
    },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string; message?: string };
  };
  if (!response.ok)
    throw Object.assign(
      new Error(body.error?.message ?? `Liege API returned ${response.status}.`),
      {
        code: body.error?.code,
      },
    );
  return (body.data ?? body) as T;
};

export async function getJob(jobId: string) {
  return request<LiegeJob>(`/v1/jobs/${encodeURIComponent(jobId)}`);
}

export async function getBrief(jobId: string) {
  const value = await request<{ content?: string; payload?: string }>(
    `/v1/jobs/${encodeURIComponent(jobId)}/payload/brief`,
  );
  const brief = value.content ?? value.payload;
  if (!brief) throw new Error("Liege returned no authorized brief.");
  return brief;
}

export async function getRevision(jobId: string) {
  const value = await request<{ feedback?: string; previousDeliverable?: string | null }>(
    `/v1/jobs/${encodeURIComponent(jobId)}/revision`,
  );
  if (!value.feedback) throw new Error("Liege returned no revision feedback.");
  return { feedback: value.feedback, previousDeliverable: value.previousDeliverable ?? null };
}

/** Every attachment on the job with its contents, in the order the client added them. */
export async function getAttachments(jobId: string) {
  const path = `/v1/jobs/${encodeURIComponent(jobId)}/attachments`;
  const list = await request<JobAttachment[]>(path).catch((error: { code?: string }) => {
    // An API from before attachments existed has no such route: the job has none.
    if (error.code === "not_found") return [];
    throw error;
  });
  return Promise.all(
    list.map((item) => request<JobAttachment>(`${path}/${encodeURIComponent(item.id)}`)),
  );
}

export async function getBid(bidId: string) {
  return request<BidInvitation>(`/v1/super-agents/bids/${encodeURIComponent(bidId)}`);
}

export async function submitBid(bidId: string, answer: BidAnswer) {
  return request<{ id: string; status: string }>(
    `/v1/super-agents/bids/${encodeURIComponent(bidId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answer),
    },
  );
}

export async function submitDeliverable(
  jobId: string,
  deliverable: string,
  evidence: string[] = [],
) {
  return request<LiegeJob>(`/v1/jobs/${encodeURIComponent(jobId)}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deliverable, evidence }),
  });
}

export async function declineJob(jobId: string, reason: string) {
  return request<LiegeJob>(`/v1/jobs/${encodeURIComponent(jobId)}/decline`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
}

export async function claimEvent(eventId: string, agentId: string) {
  return request<{ claimed: boolean }>("/v1/internal/runtime/event-receipts/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId, agentId }),
  });
}

export async function completeEvent(eventId: string, agentId: string) {
  await request("/v1/internal/runtime/event-receipts/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId, agentId }),
  });
}

export type ProgressStage = "started" | "researching" | "drafting" | "reviewing" | "finalizing";

// Progress is informational: a failed report must never delay or fail the job itself.
export async function reportProgress(
  jobId: string,
  stage: ProgressStage,
  message: string,
  percent?: number,
) {
  try {
    await request(`/v1/jobs/${encodeURIComponent(jobId)}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage, message, ...(percent === undefined ? {} : { percent }) }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "progress.report_failed",
        jobId,
        stage,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
