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
  status: () => request("/v1/status").then((body) => body.data),
  leaderboard: () => request("/v1/leaderboard").then((body) => body.data),
  agent: (slug) => request(`/v1/agents/${encodeURIComponent(slug)}`),
  agentReputation: (slug) => request(`/v1/agents/${encodeURIComponent(slug)}/reputation`),
  agentReputationProof: (slug) =>
    request(`/v1/agents/${encodeURIComponent(slug)}/reputation-proof`).then((body) => body.data),
  services: (options = {}) => {
    const query = new URLSearchParams();
    if (options.agentId) query.set("agentId", options.agentId);
    if (options.type && options.type !== "All") query.set("type", options.type);
    query.set("limit", String(options.limit || 100));
    return request(`/v1/services?${query}`);
  },
  createService: (token, input) =>
    request("/v1/services", { token, method: "POST", body: JSON.stringify(input) }),
  setServiceExample: (token, id, example) =>
    request(`/v1/services/${encodeURIComponent(id)}/example`, {
      token,
      method: "PATCH",
      body: JSON.stringify(example),
    }),
  service: (agentId, slug) =>
    request(`/v1/services/${encodeURIComponent(agentId)}/${encodeURIComponent(slug)}`),
  me: (token) => request("/v1/me", { token }),
  ledger: (token) => request("/v1/me/ledger", { token }),
  notifications: (token, limit = 50) =>
    request(`/v1/notifications?limit=${encodeURIComponent(limit)}`, { token }),
  markNotificationRead: (token, id) =>
    request(`/v1/notifications/${encodeURIComponent(id)}/read`, { token, method: "POST" }),
  markAllNotificationsRead: (token) =>
    request("/v1/notifications/read-all", { token, method: "POST" }),
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
  evaluators: (asset) =>
    request(`/v1/evaluators${asset ? `?asset=${encodeURIComponent(asset)}` : ""}`),
  evaluatorProfile: (token) => request("/v1/evaluators/me", { token }),
  updateEvaluatorProfile: (token, input) =>
    request("/v1/evaluators/me", { token, method: "PUT", body: JSON.stringify(input) }),
  createAgent: (token, input) =>
    request("/v1/agents", { token, method: "POST", body: JSON.stringify(input) }),
  deactivateAgent: (token, id) =>
    request(`/v1/agents/${encodeURIComponent(id)}/deactivate`, { token, method: "POST" }),
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
  veiloraOutcomePreview: (token, id, input) =>
    request(`/v1/jobs/${id}/evaluate-preview`, {
      token,
      method: "POST",
      body: JSON.stringify(input),
    }),
  requestRevision: (token, id, feedback) =>
    request(`/v1/jobs/${id}/revision`, {
      token,
      method: "POST",
      body: JSON.stringify({ feedback }),
    }),
  jobRevision: (token, id) => request(`/v1/jobs/${id}/revision`, { token }),
  jobAttachments: (token, id) => request(`/v1/jobs/${id}/attachments`, { token }),
  jobReceipt: (token, id) => request(`/v1/jobs/${id}/receipt`, { token }),
  jobChallenge: (token, id) => request(`/v1/jobs/${id}/challenge`, { token }),
  reviewJob: (token, id, review) =>
    request(`/v1/jobs/${id}/review`, { token, method: "POST", body: JSON.stringify(review) }),
  replyToReview: (token, id, reply) =>
    request(`/v1/jobs/${id}/review/reply`, {
      token,
      method: "POST",
      body: JSON.stringify({ reply }),
    }),
  agentReviews: (slug, before) =>
    request(
      `/v1/agents/${encodeURIComponent(slug)}/reviews${before ? `?before=${encodeURIComponent(before)}` : ""}`,
    ),
  addBonus: (token, id, amount) =>
    request(`/v1/jobs/${id}/bonus`, { token, method: "POST", body: JSON.stringify({ amount }) }),
  secondOpinion: (token, id) => request(`/v1/jobs/${id}/second-opinion`, { token }),
  requestSecondOpinion: (token, id) =>
    request(`/v1/jobs/${id}/second-opinion`, { token, method: "POST" }),
  topups: (token) => request("/v1/me/topups", { token }),
  spendLimits: (token) => request("/v1/me/spend-limits", { token }),
  milestonePlans: (token) => request("/v1/milestones", { token }),
  retainers: (token) => request("/v1/retainers", { token }),
  hireableSuperAgents: (asset = "usdg") => request(`/v1/super-agents/hireable?asset=${asset}`),
  jobWatchLink: (token, id) => request(`/v1/jobs/${id}/watch-link`, { token }),
  shareJobWatchLink: (token, id) =>
    request(`/v1/jobs/${id}/watch-link`, { token, method: "POST", body: "{}" }),
  revokeJobWatchLink: (token, id) =>
    request(`/v1/jobs/${id}/watch-link`, { token, method: "DELETE" }),
  watchJob: (token) => request(`/v1/watch/${token}`),
  createRetainer: (token, body) =>
    request("/v1/retainers", { token, method: "POST", body: JSON.stringify(body) }),
  retainerTask: (token, id, task, amount) =>
    request(`/v1/retainers/${id}/tasks`, {
      token,
      method: "POST",
      body: JSON.stringify({ request: task, amount }),
    }),
  cancelRetainer: (token, id) =>
    request(`/v1/retainers/${id}/cancel`, { token, method: "POST", body: "{}" }),
  createMilestonePlan: (token, body) =>
    request("/v1/milestones", { token, method: "POST", body: JSON.stringify(body) }),
  cancelMilestonePlan: (token, id) =>
    request(`/v1/milestones/${id}/cancel`, { token, method: "POST", body: "{}" }),
  setSpendLimits: (token, asset, daily, monthly) =>
    request(`/v1/me/spend-limits/${asset}`, {
      token,
      method: "PUT",
      body: JSON.stringify({ daily, monthly }),
    }),
  balanceAlerts: (token) => request("/v1/me/balance-alerts", { token }),
  setBalanceAlert: (token, asset, threshold) =>
    request(`/v1/me/balance-alerts/${asset}`, {
      token,
      method: "PUT",
      body: JSON.stringify({ threshold }),
    }),
  removeBalanceAlert: (token, asset) =>
    request(`/v1/me/balance-alerts/${asset}`, { token, method: "DELETE" }),
  telegram: (token) => request("/v1/me/telegram", { token }),
  startTelegramLink: (token) => request("/v1/me/telegram/link", { token, method: "POST" }),
  setTelegramCap: (token, dailyCapUsdg) =>
    request("/v1/me/telegram", {
      token,
      method: "PUT",
      body: JSON.stringify({ dailyCapUsdg }),
    }),
  unlinkTelegram: (token) => request("/v1/me/telegram", { token, method: "DELETE" }),
  claimTopup: (token, txHash, asset) =>
    request("/v1/me/topups", {
      token,
      method: "POST",
      body: JSON.stringify({ txHash, asset }),
    }),
  panelDisputes: (token) => request("/v1/disputes", { token }),
  panelDispute: (token, id) => request(`/v1/disputes/${id}`, { token }),
  votePanelDispute: (token, id, decision, rationale) =>
    request(`/v1/disputes/${id}/vote`, {
      token,
      method: "POST",
      body: JSON.stringify({ decision, rationale }),
    }),
  challengeJob: (token, id, reason) =>
    request(`/v1/jobs/${id}/challenge`, {
      token,
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  appealJob: (token, id, reason) =>
    request(`/v1/jobs/${id}/appeal`, {
      token,
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  jobAttachment: (token, id, attachmentId) =>
    request(`/v1/jobs/${id}/attachments/${attachmentId}`, { token }),
  attachLink: (token, id, input) =>
    request(`/v1/jobs/${id}/attachments`, {
      token,
      method: "POST",
      body: JSON.stringify(input),
    }),
  // The file travels as the raw body with its own type, not as JSON.
  attachFile: (token, id, file) =>
    request(`/v1/jobs/${id}/attachments/file?name=${encodeURIComponent(file.name)}`, {
      token,
      method: "POST",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    }),
  removeAttachment: (token, id, attachmentId) =>
    request(`/v1/jobs/${id}/attachments/${attachmentId}`, { token, method: "DELETE" }),
  legion: (token, id) => request(`/v1/jobs/${id}/legion`, { token }),
  createLegionAssignment: (token, id, input) =>
    request(`/v1/jobs/${id}/legion/assignments`, {
      token,
      method: "POST",
      body: JSON.stringify(input),
    }),
  respondToLegionAssignment: (token, id, assignmentId, action, input) =>
    request(`/v1/jobs/${id}/legion/assignments/${assignmentId}/${action}`, {
      token,
      method: "POST",
      body: input ? JSON.stringify(input) : undefined,
    }),
  legionAssignmentPayload: (token, id, assignmentId) =>
    request(`/v1/jobs/${id}/legion/assignments/${assignmentId}/payload`, { token }),
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
  runnerRuns: (token) => request("/v1/runners", { token }),
  runnerRun: (token, id) => request(`/v1/runners/${encodeURIComponent(id)}`, { token }),
  runnerArtifact: (token, runId, artifactId) =>
    request(
      `/v1/runners/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        token,
      },
    ),
  mcpProposals: (token) => request("/v1/mcp/proposals", { token }),
  decideMcpProposal: (token, id, decision) =>
    request(`/v1/mcp/proposals/${encodeURIComponent(id)}/${decision}`, {
      token,
      method: "POST",
    }),
  creditTestBalance: (token, input) =>
    request("/v1/admin/ledger/credit", { token, method: "POST", body: JSON.stringify(input) }),
  setEvaluatorStake: (token, input) =>
    request("/v1/admin/evaluators/stake", { token, method: "POST", body: JSON.stringify(input) }),
  backfillEscrows: (token, input = {}) =>
    request("/v1/admin/escrows/backfill", { token, method: "POST", body: JSON.stringify(input) }),
  mcpConnections: (token) => request("/v1/mcp/connections", { token }),
  webhooks: (token) => request("/v1/webhooks", { token }),
  webhookDeliveries: (token, id, limit = 30) =>
    request(
      `/v1/webhooks/${encodeURIComponent(id)}/deliveries?limit=${encodeURIComponent(limit)}`,
      {
        token,
      },
    ),
  createMcpConnection: (token, input) =>
    request("/v1/mcp/connections", { token, method: "POST", body: JSON.stringify(input) }),
  revokeMcpConnection: (token, id) =>
    request(`/v1/mcp/connections/${encodeURIComponent(id)}`, { token, method: "DELETE" }),
  mcpPresets: (token, id, queryToken) =>
    request(
      `/v1/mcp/connections/${encodeURIComponent(id)}/presets${queryToken ? `?token=${encodeURIComponent(queryToken)}` : ""}`,
      { token },
    ),
  mcpGeneralPresets: (token, { name, agentId, queryToken } = {}) => {
    const params = new URLSearchParams();
    if (name) params.set("name", name);
    if (agentId) params.set("agentId", agentId);
    if (queryToken) params.set("token", queryToken);
    const qs = params.toString();
    return request(`/v1/mcp/presets${qs ? `?${qs}` : ""}`, { token });
  },
  mobilePairingCode: (token) => request("/v1/mobile/pairing-codes", { token, method: "POST" }),
  mobileDevices: (token) => request("/v1/mobile/devices", { token }),
  revokeMobileDevice: (token, id) =>
    request(`/v1/mobile/devices/${encodeURIComponent(id)}`, { token, method: "DELETE" }),
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
  "Customer service": ["support", "#ff8a6b"],
  "Onchain security": ["shield", "#ffd166"],
};
export function agentForDisplay(agent) {
  const [icon, color] = display[agent.category] || ["flow", "#18e299"];
  const services = Array.isArray(agent.services) ? agent.services : [];
  const servicePrices = services
    .map((service) => Number(service.price_usd))
    .filter((price) => Number.isFinite(price) && price > 0);
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
    services,
    servicePriceUsd: servicePrices.length ? Math.min(...servicePrices) : null,
    icon,
    color,
    price: Number(agent.metadata?.startingJobFeeUsdg || 0),
    jobs: Number(agent.metadata?.completedJobs || 0),
    // Null until the agent has enough recorded outcomes to be scored.
    score: agent.reputation?.status === "scored" ? agent.reputation.score : null,
    // Completed, rejected, and undelivered jobs Liege recorded; scores start at 5.
    outcomes: Number(agent.reputation?.outcomes || 0),
    verified: Boolean(agent.verified),
    live: true,
  };
}

export function agentAcceptsSettlementAsset(agent, asset) {
  return (Array.isArray(agent.services) ? agent.services : []).some((service) =>
    (Array.isArray(service.settlement_assets) ? service.settlement_assets : []).some(
      (acceptedAsset) => String(acceptedAsset).toLowerCase() === asset.toLowerCase(),
    ),
  );
}

export function marketplaceAgentMatches(agent, filters) {
  const {
    category = "All",
    settlementAsset = "all",
    savedOnly = false,
    saved = [],
    query = "",
    verifiedOnly = false,
  } = filters;
  const searchText = [agent.name, agent.category, agent.description, ...(agent.tags || [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    (category === "All" || category === "Saved" || agent.category === category) &&
    (settlementAsset === "all" || agentAcceptsSettlementAsset(agent, settlementAsset)) &&
    (!savedOnly || saved.includes(agent.id)) &&
    (!verifiedOnly || agent.verified) &&
    searchText.includes(query.trim().toLowerCase())
  );
}
/**
 * Strongest recorded track record first: scored agents by score, then by recorded outcomes, with
 * verified agents ahead on a tie. Only Liege-recorded outcomes count, never ratings.
 */
export function compareTrackRecord(a, b) {
  return (
    (b.score ?? -1) - (a.score ?? -1) ||
    (b.outcomes || 0) - (a.outcomes || 0) ||
    Number(Boolean(b.verified)) - Number(Boolean(a.verified)) ||
    a.name.localeCompare(b.name)
  );
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
