import {
  LiegeAPIError,
  type Invoice,
  type InvoiceAsset,
  type InvoiceRefund,
  type RefundInvoiceInput,
  type OtelTraceExport,
  type Receipt,
  type StatementResponse,
  type Service,
  type ServiceType,
  type AgentAccount,
  type AgentActionAuthorization,
  type AgentActionInput,
  type AgentActionSimulation,
  type AgentControlResult,
  type AgentPolicyInput,
  type Job,
  type JobEvent,
  type Session,
  type Signer,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402Signer,
  type EventStreamOptions,
} from "./types.js";

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
  listInvoices(): Promise<Invoice[]> { return this.call("/v1/invoices"); }
  getInvoice(id: string): Promise<Invoice> { return this.call(`/v1/invoices/${encodeURIComponent(id)}`); }
  createInvoice(input: { agentId: string; description: string; amount?: string | number; amountUsdg?: string | number; asset?: InvoiceAsset | string; expiresAt: string; reference?: string }): Promise<Invoice> { return this.call("/v1/invoices", { method: "POST", body: input }); }
  payInvoice(id: string): Promise<Invoice> { return this.call(`/v1/invoices/${encodeURIComponent(id)}/pay`, { method: "POST" }); }
  refundInvoice(id: string, input?: RefundInvoiceInput): Promise<Invoice> { return this.call(`/v1/invoices/${encodeURIComponent(id)}/refund`, { method: "POST", body: input }); }
  listInvoiceRefunds(id: string): Promise<InvoiceRefund[]> { return this.call(`/v1/invoices/${encodeURIComponent(id)}/refunds`); }
  cancelInvoice(id: string): Promise<Invoice> { return this.call(`/v1/invoices/${encodeURIComponent(id)}/cancel`, { method: "POST" }); }

  listReceipts(options: { format: "otel"; limit?: number }): Promise<OtelTraceExport>;
  listReceipts(options?: { format?: "json"; limit?: number }): Promise<Receipt[]>;
  listReceipts(options: { format: "csv"; limit?: number }): Promise<string>;
  listReceipts(options?: { format?: "json" | "csv" | "otel"; limit?: number }): Promise<Receipt[] | OtelTraceExport | string> {
    const query = new URLSearchParams({ limit: String(options?.limit ?? 500) });
    if (options?.format) query.set("format", options.format);
    if (options?.format === "csv") {
      return this.request(`${this.baseUrl}/v1/receipts?${query}`, { headers: this.headers() }).then((r) => r.text());
    }
    return this.call(`/v1/receipts?${query}`);
  }

  getReceipt(id: string, options?: { format?: "json" }): Promise<{ data: Receipt }>;
  getReceipt(id: string, options: { format: "otel" }): Promise<OtelTraceExport>;
  getReceipt(id: string, options?: { format?: "json" | "otel" }): Promise<{ data: Receipt } | OtelTraceExport> {
    const query = options?.format ? `?format=${options.format}` : "";
    return this.call(`/v1/receipts/${encodeURIComponent(id)}${query}`);
  }

  listServices(options: { agentId?: string; type?: ServiceType; limit?: number } = {}): Promise<Service[]> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.agentId) query.set("agentId", options.agentId);
    if (options.type) query.set("type", options.type);
    return this.call<Record<string, unknown>[]>(`/v1/services?${query}`).then((items) => items.map((item) => this.mapService(item)));
  }
  getService(agentId: string, slug: string): Promise<Service> {
    return this.call<Record<string, unknown>>(`/v1/services/${encodeURIComponent(agentId)}/${encodeURIComponent(slug)}`).then((item) => this.mapService(item));
  }
  createService(input: {
    agentId: string; slug: string; name: string; description: string; serviceType: ServiceType;
    executionMode?: "manual" | "sandboxed_runner"; priceUsd: string | number; slaMinutes: number;
    requirementsSchema?: Record<string, unknown>; deliverableSchema?: Record<string, unknown>;
  }): Promise<Service> { return this.call<Record<string, unknown>>("/v1/services", { method: "POST", body: input }).then((item) => this.mapService(item)); }

  getAccount(agentId: string): Promise<AgentAccount> {
    return this.call<Record<string, unknown>>(`/v1/agent-accounts/${encodeURIComponent(agentId)}`).then((item) => this.mapAccount(item));
  }
  updatePolicy(agentId: string, policy: AgentPolicyInput): Promise<AgentAccount> {
    return this.call<Record<string, unknown>>(`/v1/agent-accounts/${encodeURIComponent(agentId)}/policy`, { method: "PUT", body: policy }).then((item) => this.mapAccount(item));
  }
  simulateAction(agentId: string, action: AgentActionInput): Promise<AgentActionSimulation> {
    return this.call<Record<string, unknown>>(`/v1/agent-accounts/${encodeURIComponent(agentId)}/actions/simulate`, { method: "POST", body: action }).then((item) => this.mapSimulation(item));
  }
  authorizeAction(agentId: string, action: AgentActionInput): Promise<AgentActionAuthorization> {
    return this.call<Record<string, unknown>>(`/v1/agent-accounts/${encodeURIComponent(agentId)}/actions/authorize`, { method: "POST", body: action }).then((item) => this.mapAuthorization(item));
  }
  approveAction(agentId: string, actionId: string): Promise<AgentActionAuthorization> {
    return this.call<Record<string, unknown>>(`/v1/agent-accounts/${encodeURIComponent(agentId)}/actions/${encodeURIComponent(actionId)}/approve`, { method: "POST" }).then((item) => this.mapAuthorization(item));
  }
  pauseAgent(agentId: string, reason?: string): Promise<AgentControlResult> { return this.controlAgent(agentId, "pause", reason); }
  resumeAgent(agentId: string): Promise<AgentControlResult> { return this.controlAgent(agentId, "resume"); }
  killAgent(agentId: string, reason?: string): Promise<AgentControlResult> { return this.controlAgent(agentId, "kill", reason); }
  private controlAgent(agentId: string, command: "pause" | "resume" | "kill", reason?: string): Promise<AgentControlResult> {
    return this.call<Record<string, unknown>>(`/v1/agent-accounts/${encodeURIComponent(agentId)}/control`, { method: "POST", body: { command, ...(reason ? { reason } : {}) } }).then((item) => ({
      ...item, accountId: String(item.accountId ?? item.agentId), status: item.status as AgentControlResult["status"],
      revokedConnections: Number(item.revokedConnections ?? 0), rejectedProposals: Number(item.rejectedProposals ?? 0),
    }));
  }

  /** Fetch an x402 resource, asking the application-provided signer to approve a 402 challenge. */
  async requestX402(input: string | URL, signer: X402Signer, init: RequestInit = {}): Promise<Response> {
    const first = await this.request(input, init);
    if (first.status !== 402) return first;
    const encoded = first.headers.get("PAYMENT-REQUIRED") ?? first.headers.get("X-PAYMENT-REQUIRED");
    if (!encoded) throw new LiegeAPIError("The x402 response did not include PAYMENT-REQUIRED", 502, "x402_invalid_challenge");
    const challenge = decodeX402PaymentRequired(encoded);
    const signed = await signer(challenge);
    const paymentSignature = typeof signed === "string" ? signed : encodeX402Json(signed);
    const headers = new Headers(init.headers);
    headers.set("PAYMENT-SIGNATURE", paymentSignature);
    return this.request(input, { ...init, headers });
  }

  async *iterEvents(agentId: string, sinceOrOptions?: Date | EventStreamOptions): AsyncGenerator<JobEvent> {
    const options = sinceOrOptions instanceof Date ? { since: sinceOrOptions } : (sinceOrOptions ?? {});
    yield* this.readEvents(agentId, options);
  }

  async *streamEvents(agentId: string, options: EventStreamOptions = {}): AsyncGenerator<JobEvent> {
    let cursor = options.after;
    let retries = 0;
    const seen = new Set<string>();
    for (;;) {
      try {
        for await (const event of this.readEvents(agentId, { ...options, after: cursor, since: cursor ? undefined : options.since })) {
          if (event.id && seen.has(event.id)) continue;
          if (event.id) {
            seen.add(event.id);
            if (seen.size > 2048) seen.delete(seen.values().next().value as string);
            cursor = event.id;
          }
          yield event;
        }
        retries = 0;
        if (options.maxRetries === 0) return;
      } catch (error) {
        if (error instanceof LiegeAPIError && error.status < 500) throw error;
        if (options.maxRetries !== undefined && retries >= options.maxRetries) throw error;
      }
      retries++;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, (options.backoffMs ?? 1_000) * 2 ** Math.min(retries - 1, 5))));
    }
  }

  private async *readEvents(agentId: string, options: Pick<EventStreamOptions, "after" | "since">): AsyncGenerator<JobEvent> {
    const url = new URL(`/v1/webhooks/stream/${encodeURIComponent(agentId)}`, this.baseUrl);
    if (options.after) url.searchParams.set("after", options.after);
    else if (options.since) url.searchParams.set("since", options.since.toISOString());
    const headers = new Headers(this.headers());
    if (options.after) headers.set("Last-Event-ID", options.after);
    const response = await this.request(url, { headers });
    if (!response.ok || !response.body) throw new LiegeAPIError("Unable to open the event stream", response.status);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let id = ""; let event = "message"; let data: string[] = [];
    const processLine = (raw: string): JobEvent | undefined => { const line = raw.replace(/\r$/, ""); if (!line.trim()) { if (!data.length) return; const parsed = { id, event, data: JSON.parse(data.join("\n")) }; id = ""; event = "message"; data = []; return parsed; } const [field, ...rest] = line.split(":"); const value = rest.join(":").trimStart(); if (field === "id") id = value; else if (field === "event") event = value; else if (field === "data") data.push(value); };
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? ""; for (const line of lines) { const parsed = processLine(line); if (parsed) yield parsed; } }
      buffer += decoder.decode(); if (buffer) buffer += "\n\n"; for (const line of buffer.split("\n")) { const parsed = processLine(line); if (parsed) yield parsed; }
    } finally { await reader.cancel().catch(() => undefined); }
  }

  private headers(): HeadersInit { return this.token ? { Authorization: `Bearer ${this.token}` } : {}; }
  private mapService(value: Record<string, unknown>): Service {
    return {
      ...value,
      id: String(value.id),
      agentId: String(value.agentId ?? value.agent_id),
      slug: String(value.slug),
      name: String(value.name),
      description: String(value.description),
      serviceType: (value.serviceType ?? value.service_type) as Service["serviceType"],
      executionMode: (value.executionMode ?? value.execution_mode ?? "manual") as Service["executionMode"],
      priceUsd: Number(value.priceUsd ?? value.price_usd),
      slaMinutes: Number(value.slaMinutes ?? value.sla_minutes),
      requirementsSchema: (value.requirementsSchema ?? value.requirements_schema ?? {}) as Record<string, unknown>,
      deliverableSchema: (value.deliverableSchema ?? value.deliverable_schema ?? {}) as Record<string, unknown>,
    };
  }
  private mapAccount(value: Record<string, unknown>): AgentAccount {
    const policy = value.policy as Record<string, unknown> | null | undefined;
    return { ...value, accountId: String(value.accountId ?? value.agentId), agentId: String(value.agentId), status: value.status as AgentAccount["status"], policy: policy ? {
      ...policy, version: Number(policy.version), maxActionAmount: policy.maxActionAmount == null ? null : String(policy.maxActionAmount), dailyBudget: policy.dailyBudget == null ? null : String(policy.dailyBudget), monthlyBudget: policy.monthlyBudget == null ? null : String(policy.monthlyBudget), requireHumanAbove: policy.requireHumanAbove == null ? null : String(policy.requireHumanAbove),
    } as AgentAccount["policy"] : null };
  }
  private mapSimulation(value: Record<string, unknown>): AgentActionSimulation {
    return { ...value, id: String(value.id), actionDigest: String(value.actionDigest ?? value.action_digest ?? ""), action: (value.action ?? {}) as Record<string, unknown>, result: (value.result ?? {}) as Record<string, unknown>, policyVersion: Number(value.policyVersion ?? value.policy_version), expiresAt: String(value.expiresAt ?? value.expires_at ?? ""), createdAt: String(value.createdAt ?? value.created_at ?? "") };
  }
  private mapAuthorization(value: Record<string, unknown>): AgentActionAuthorization {
    return { ...value, actionId: String(value.actionId ?? value.id), accountId: String(value.accountId ?? value.agentId), decision: String(value.decision), reasons: (value.reasons ?? []) as string[], policyVersion: Number(value.policyVersion ?? value.policy_version), simulationDigest: (value.simulationDigest ?? value.simulation_digest ?? null) as string | null, createdAt: String(value.createdAt ?? value.created_at ?? "") };
  }
  private async call<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await this.request(`${this.baseUrl}${path}`, { method: options.method ?? "GET", headers: { ...this.headers(), ...(options.body ? { "content-type": "application/json" } : {}) }, body: options.body ? JSON.stringify(options.body) : undefined });
    const body = await response.json().catch(() => ({})); if (!response.ok) { const error = body?.error ?? {}; throw new LiegeAPIError(error.message ?? response.statusText, response.status, error.code); }
    return body?.data ?? body;
  }
}

export function encodeX402Json(value: X402PaymentPayload): string {
  const json = JSON.stringify(value);
  return typeof btoa === "function" ? btoa(json) : Buffer.from(json).toString("base64");
}

export function decodeX402PaymentRequired(value: string): X402PaymentRequired {
  try {
    const json = typeof atob === "function" ? atob(value) : Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(json) as X402PaymentRequired;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.accepts) || parsed.accepts.length === 0)
      throw new Error("invalid challenge");
    return parsed;
  } catch {
    throw new LiegeAPIError("The x402 PAYMENT-REQUIRED header is invalid", 502, "x402_invalid_challenge");
  }
}

export function decodeX402PaymentResponse(value: string): Record<string, unknown> {
  try {
    const json = typeof atob === "function" ? atob(value) : Buffer.from(value, "base64").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new LiegeAPIError("The x402 PAYMENT-RESPONSE header is invalid", 502, "x402_invalid_response");
  }
}
