const API_URL = "/api";

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request(path, { token, ...options } = {}) {
  const response = await fetch(API_URL + path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token && token !== "cookie" ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      body?.error?.message || `Request failed (${response.status}).`,
      response.status,
      body?.error?.code,
    );
  return body;
}

export async function createWalletSession(address, signMessage) {
  const nonce = await request("/v1/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ address }),
  });
  const message = nonce.data?.message;
  if (!message) throw new ApiError("The API did not return a sign-in message.");
  const signature = await signMessage(message);
  const verified = await request("/v1/auth/verify", {
    method: "POST",
    body: JSON.stringify({ address, nonce: nonce.data.nonce, signature }),
  });
  return verified.data;
}

export const api = {
  url: API_URL,
  agents: () => request("/v1/agents"),
  agent: (slug) => request(`/v1/agents/${encodeURIComponent(slug)}`),
  services: (options = {}) => {
    const query = new URLSearchParams();
    if (options.agentId) query.set("agentId", options.agentId);
    if (options.type && options.type !== "All") query.set("type", options.type);
    query.set("limit", String(options.limit || 100));
    return request(`/v1/services?${query}`);
  },
  createService: (token, input) =>
    request("/v1/services", { token, method: "POST", body: JSON.stringify(input) }),
  service: (agentId, slug) =>
    request(`/v1/services/${encodeURIComponent(agentId)}/${encodeURIComponent(slug)}`),
  me: (token) => request("/v1/me", { token }),
  ledger: (token) => request("/v1/me/ledger", { token }),
  jobs: (token) => request("/v1/jobs", { token }),
  job: (token, id) => request(`/v1/jobs/${id}`, { token }),
  jobPayload: (token, id, payload) => request(`/v1/jobs/${id}/payload/${payload}`, { token }),
  jobPayloadAccess: (token, id) => request(`/v1/jobs/${id}/payload-access`, { token }),
  jobObservability: (token, id) => request(`/v1/jobs/${id}/observability`, { token }),
  invoices: (token) => request("/v1/invoices", { token }),
  invoicePayment: (id) => request(`/v1/invoices/${encodeURIComponent(id)}/payment`),
  createInvoice: (token, input) =>
    request("/v1/invoices", { token, method: "POST", body: JSON.stringify(input) }),
  payInvoice: (token, id) =>
    request(`/v1/invoices/${encodeURIComponent(id)}/pay`, { token, method: "POST" }),
  refundInvoice: (token, id, input) =>
    request(`/v1/invoices/${encodeURIComponent(id)}/refund`, {
      token,
      method: "POST",
      body: input ? JSON.stringify(input) : undefined,
    }),
  invoiceRefunds: (token, id) =>
    request(`/v1/invoices/${encodeURIComponent(id)}/refunds`, { token }),
  cancelInvoice: (token, id) =>
    request(`/v1/invoices/${encodeURIComponent(id)}/cancel`, { token, method: "POST" }),
  evaluators: () => request("/v1/evaluators"),
  evaluatorProfile: (token) => request("/v1/evaluators/me", { token }),
  updateEvaluatorProfile: (token, input) =>
    request("/v1/evaluators/me", { token, method: "PUT", body: JSON.stringify(input) }),
  createAgent: (token, input) =>
    request("/v1/agents", { token, method: "POST", body: JSON.stringify(input) }),
  createJob: (token, input) =>
    request("/v1/jobs", { token, method: "POST", body: JSON.stringify(input) }),
  simulateJob: (token, input) =>
    request("/v1/jobs/simulate", { token, method: "POST", body: JSON.stringify(input) }),
  fundingQuote: (token, id) => request(`/v1/jobs/${id}/funding-quote`, { token, method: "POST" }),
  fundJob: (token, id, input) =>
    request(`/v1/jobs/${id}/fund`, {
      token,
      method: "POST",
      body: input ? JSON.stringify(input) : undefined,
    }),
  submitJob: (token, id, input) =>
    request(`/v1/jobs/${id}/submit`, { token, method: "POST", body: JSON.stringify(input) }),
  evaluateJob: (token, id, input) =>
    request(`/v1/jobs/${id}/evaluate`, { token, method: "POST", body: JSON.stringify(input) }),
  evaluationTasks: (token) => request("/v1/evaluations/tasks", { token }),
  createEvaluationTask: (token, input) =>
    request("/v1/evaluations/tasks", { token, method: "POST", body: JSON.stringify(input) }),
  evaluationDecisionMessage: (token, id, input) =>
    request(`/v1/evaluations/tasks/${id}/decision-message`, {
      token,
      method: "POST",
      body: JSON.stringify(input),
    }),
  submitEvaluationDecision: (token, id, input) =>
    request(`/v1/evaluations/tasks/${id}/submit`, {
      token,
      method: "POST",
      body: JSON.stringify(input),
    }),
  creditTestBalance: (token, input) =>
    request("/v1/admin/ledger/credit", { token, method: "POST", body: JSON.stringify(input) }),
  setEvaluatorStake: (token, input) =>
    request("/v1/admin/evaluators/stake", { token, method: "POST", body: JSON.stringify(input) }),
  backfillEscrows: (token, input = {}) =>
    request("/v1/admin/escrows/backfill", { token, method: "POST", body: JSON.stringify(input) }),
  mcpConnections: (token) => request("/v1/mcp/connections", { token }),
  createMcpConnection: (token, input) =>
    request("/v1/mcp/connections", { token, method: "POST", body: JSON.stringify(input) }),
  revokeMcpConnection: (token, id) =>
    request(`/v1/mcp/connections/${encodeURIComponent(id)}`, { token, method: "DELETE" }),
  agentAccounts: (token) => request("/v1/agent-accounts", { token }),
  receipts: (token, limit = 25) => request(`/v1/receipts?limit=${limit}`, { token }),
  receipt: (token, id) => request(`/v1/receipts/${encodeURIComponent(id)}`, { token }),
  receiptExportUrl: (format) => {
    if (format === "csv") return `${API_URL}/v1/receipts?format=csv&limit=5000`;
    if (format === "otel") return `${API_URL}/v1/receipts?format=otel&download=1&limit=5000`;
    return `${API_URL}/v1/receipts?download=1&limit=5000`;
  },
  agentAccount: (token, agentId) =>
    request(`/v1/agent-accounts/${encodeURIComponent(agentId)}`, { token }),
  updateAgentPolicy: (token, agentId, input) =>
    request(`/v1/agent-accounts/${encodeURIComponent(agentId)}/policy`, {
      token,
      method: "PUT",
      body: JSON.stringify(input),
    }),
  controlAgentAccount: (token, agentId, input) =>
    request(`/v1/agent-accounts/${encodeURIComponent(agentId)}/control`, {
      token,
      method: "POST",
      body: JSON.stringify(input),
    }),
  agentMandates: (token, agentId) =>
    request(`/v1/agent-accounts/${encodeURIComponent(agentId)}/mandates`, { token }),
  agentMandateAp2: (token, agentId, mandateId) =>
    request(
      `/v1/agent-accounts/${encodeURIComponent(agentId)}/mandates/${encodeURIComponent(mandateId)}/ap2`,
      { token },
    ),
  agentMandateAp2Url: (agentId, mandateId) =>
    `${API_URL}/v1/agent-accounts/${encodeURIComponent(agentId)}/mandates/${encodeURIComponent(mandateId)}/ap2?download=1`,
};

const display = {
  Research: ["research", "#d87cff"],
  Development: ["code", "#baff24"],
  "Data analysis": ["data", "#44aeff"],
  Automation: ["flow", "#ffa723"],
  Strategy: ["chart", "#ffa3d3"],
};
export function agentForDisplay(agent) {
  const [icon, color] = display[agent.category] || ["flow", "#18e299"];
  const configuredSymbol =
    typeof agent.metadata?.symbol === "string" ? agent.metadata.symbol.trim().toUpperCase() : "";
  return {
    ...agent,
    symbol:
      configuredSymbol ||
      (agent.slug || agent.name)
        .replace(/[^a-z0-9]/gi, "")
        .slice(0, 4)
        .toUpperCase() ||
      "AGNT",
    tags: Array.isArray(agent.capabilities) ? agent.capabilities : [],
    icon,
    color,
    price: Number(agent.metadata?.startingJobFeeUsdg || 0),
    jobs: Number(agent.metadata?.completedJobs || 0),
    score: Math.round(Number(agent.reputation_score || 0) * 100),
    live: true,
  };
}
export function jobForDisplay(job) {
  const status = String(job.status || "open").replace(/^./, (x) => x.toUpperCase());
  const asset = job.settlement_asset || "usdg";
  return {
    ...job,
    id: job.id,
    apiId: job.id,
    agent: job.agent_id,
    asset,
    budget: Number(job.budget_amount ?? job.budget_usdg),
    status,
    brief: job.brief || "Private brief available to authorized participants.",
    deadline: String(job.deadline_at || "").slice(0, 10),
    createdAt: job.created_at,
    history: [],
    live: true,
  };
}
