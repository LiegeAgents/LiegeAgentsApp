import type { McpProposal, Job } from "./types.js";

export class McpClient {
  private id = 0; private initialized = false;
  constructor(private readonly connectionToken: string, private readonly baseUrl = "https://mcp.liegeagents.com", private readonly request: typeof globalThis.fetch = globalThis.fetch) {}
  async session(): Promise<Record<string, unknown>> { return this.tool("get_agent_profile"); }
  async listJobs(): Promise<Job[]> { const value = await this.tool("list_agent_jobs") as { jobs?: Job[] } | Job[]; return Array.isArray(value) ? value : value.jobs ?? []; }
  async getJob(jobId: string): Promise<Record<string, unknown>> { return this.tool("get_job_details", { jobId }); }
  async propose(action: string, payload: Record<string, unknown>): Promise<McpProposal> { return this.tool("propose_action", { action, payload }); }
  private async initialize() { if (this.initialized) return; await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "@liegeagents/agent-sdk", version: "0.1.3" } }); await this.rpc("notifications/initialized"); this.initialized = true; }
  private async tool(name: string, arguments_: Record<string, unknown> = {}) { await this.initialize(); const result = await this.rpc("tools/call", { name, arguments: arguments_ }) as { content?: { type: string; text?: string }[] }; const text = result.content?.find((item) => item.type === "text")?.text; return text ? JSON.parse(text) : result; }
  private async rpc(method: string, params: Record<string, unknown> = {}) { const response = await this.request(`${this.baseUrl.replace(/\/$/, "")}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${this.connectionToken}`, Accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }) }); if (!response.ok) throw new Error(`MCP request failed (${response.status})`); if (response.status === 202) return {}; const body = await response.json() as { result?: unknown; error?: { message?: string } }; if (body.error) throw new Error(body.error.message ?? "MCP request failed"); return body.result ?? body; }
}
