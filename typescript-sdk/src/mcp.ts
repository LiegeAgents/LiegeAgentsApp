import { SDK_VERSION, type McpProposal, type Job } from "./types.js";

export class McpClient {
  private id = 0; private initialized = false;
  constructor(private readonly connectionToken: string, private readonly baseUrl = "https://mcp.liegeagents.com", private readonly request: typeof globalThis.fetch = globalThis.fetch) {}
  async session(): Promise<Record<string, unknown>> { return this.tool("get_agent_profile"); }
  async listJobs(): Promise<Job[]> { const value = await this.tool("list_agent_jobs") as { jobs?: Job[] } | Job[]; return Array.isArray(value) ? value : value.jobs ?? []; }
  async getJob(jobId: string): Promise<Record<string, unknown>> { return this.tool("get_job_details", { jobId }); }
  async propose(action: string, payload: Record<string, unknown>): Promise<McpProposal> { return this.tool("propose_action", { action, payload }); }
  async accountStatus(): Promise<Record<string, unknown>> { return this.tool("liege_account_status"); }
  async accountSimulate(action: { action: string; amount?: number; asset?: string; venue?: string; counterparty?: string; details?: Record<string, unknown> }): Promise<Record<string, unknown>> { return this.tool("liege_account_simulate", action as Record<string, unknown>); }
  async accountAuthorize(action: { action: string; amount?: number; asset?: string; venue?: string; counterparty?: string; details?: Record<string, unknown>; simulationId?: string; simulationDigest?: string }): Promise<Record<string, unknown>> { return this.tool("liege_account_authorize", action as Record<string, unknown>); }
  async accountMandates(): Promise<Array<Record<string, unknown>>> { const value = await this.tool("liege_account_mandates") as Array<Record<string, unknown>> | { mandates?: Array<Record<string, unknown>> }; return Array.isArray(value) ? value : ((value as { mandates?: Array<Record<string, unknown>> })?.mandates ?? []); }
  async listServices(): Promise<Array<Record<string, unknown>>> { const value = await this.tool("list_services") as Array<Record<string, unknown>> | { services?: Array<Record<string, unknown>> }; return Array.isArray(value) ? value : ((value as { services?: Array<Record<string, unknown>> })?.services ?? []); }
  private async initialize() { if (this.initialized) return; await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "@liegeagents/agent-sdk", version: SDK_VERSION } }); await this.rpc("notifications/initialized"); this.initialized = true; }
  private async tool(name: string, arguments_: Record<string, unknown> = {}) { await this.initialize(); const result = await this.rpc("tools/call", { name, arguments: arguments_ }) as { content?: { type: string; text?: string }[] }; const text = result.content?.find((item) => item.type === "text")?.text; return text ? JSON.parse(text) : result; }
  private async rpc(method: string, params: Record<string, unknown> = {}) { const response = await this.request(`${this.baseUrl.replace(/\/$/, "")}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${this.connectionToken}`, Accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }) }); if (!response.ok) throw new Error(`MCP request failed (${response.status})`); if (response.status === 202) return {}; const body = await response.json() as { result?: unknown; error?: { message?: string } }; if (body.error) throw new Error(body.error.message ?? "MCP request failed"); return body.result ?? body; }
}
