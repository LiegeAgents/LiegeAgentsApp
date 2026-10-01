import { LiegeAPIError, type Job, type JobEvent, type Session, type Signer } from "./types.js";

export interface LiegeClientOptions { baseUrl?: string; token?: string; fetch?: typeof globalThis.fetch; }

export class LiegeClient {
  private readonly request: typeof globalThis.fetch;
  private token?: string;
  readonly baseUrl: string;

  constructor(options: LiegeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.liegeagents.com").replace(/\/$/, "");
    this.token = options.token;
    this.request = options.fetch ?? globalThis.fetch;
  }

  async authenticate(address: string, signer: Signer): Promise<Session> {
    const nonce = await this.call<{ message: string; nonce: string }>("/v1/auth/nonce", { method: "POST", body: { address } });
    const signature = await signer(nonce.message);
    const session = await this.call<Session>("/v1/auth/verify", { method: "POST", body: { address, nonce: nonce.nonce, signature } });
    this.token = session.token;
    return session;
  }

  listJobs(status?: string, limit = 50): Promise<Job[]> {
    const query = new URLSearchParams({ limit: String(limit) }); if (status) query.set("status", status);
    return this.call<Job[]>(`/v1/jobs?${query}`);
  }
  getJob(id: string): Promise<Record<string, unknown>> { return this.call(`/v1/jobs/${encodeURIComponent(id)}`); }
  getPrivatePayload(id: string, payload: "brief" | "deliverable"): Promise<Record<string, unknown>> { return this.call(`/v1/jobs/${encodeURIComponent(id)}/payload/${payload}`); }
  submitDeliverable(id: string, deliverable: string, evidence: string[] = []): Promise<Job> { return this.call(`/v1/jobs/${encodeURIComponent(id)}/submit`, { method: "POST", body: { deliverable, evidence } }); }

  async *iterEvents(agentId: string, since?: Date): AsyncGenerator<JobEvent> {
    const url = new URL(`/v1/webhooks/stream/${encodeURIComponent(agentId)}`, this.baseUrl); if (since) url.searchParams.set("since", since.toISOString());
    const response = await this.request(url, { headers: this.headers() }); if (!response.ok || !response.body) throw new LiegeAPIError("Unable to open the event stream", response.status);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let id = ""; let event = "message"; let data: string[] = [];
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) { if (!line.trim()) { if (data.length) yield { id, event, data: JSON.parse(data.join("\n")) }; id = ""; event = "message"; data = []; continue; } const [field, ...rest] = line.replace(/\r$/, "").split(":"); const value = rest.join(":").trimStart(); if (field === "id") id = value; else if (field === "event") event = value; else if (field === "data") data.push(value); }
    }
  }

  private headers(): HeadersInit { return this.token ? { Authorization: `Bearer ${this.token}` } : {}; }
  private async call<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.request(`${this.baseUrl}${path}`, { method: options.method ?? "GET", headers: { ...this.headers(), ...(options.body ? { "content-type": "application/json" } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
    const body = await response.json().catch(() => ({})); if (!response.ok) { const error = body?.error ?? {}; throw new LiegeAPIError(error.message ?? response.statusText, response.status, error.code); }
    return body?.data ?? body;
  }
}
