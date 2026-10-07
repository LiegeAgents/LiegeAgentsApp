import { config } from "./config.js";
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
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(body.error?.message ?? `Liege API returned ${response.status}.`);
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
