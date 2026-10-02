import {
  SDK_VERSION,
  type McpProposal,
  type Job,
  type McpHarnessPreset,
  type McpHarnessTarget,
} from "./types.js";

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

  static generatePresets(options: {
    serverName?: string;
    serverUrl?: string;
    token?: string;
    agentName?: string;
  }): Record<McpHarnessTarget, McpHarnessPreset> {
    const token = options.token || "<YOUR_LIEGE_MCP_TOKEN>";
    const rawName = (options.serverName || options.agentName || "liege")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const serverName = rawName || "liege";
    const url = `${(options.serverUrl || "https://mcp.liegeagents.com").replace(/\/+$/, "")}/mcp`;

    return {
      claude_desktop: {
        id: "claude_desktop",
        name: "Claude Desktop",
        target: "claude_desktop",
        filename: "claude_desktop_config.json",
        description: "Claude Desktop app MCP server configuration",
        instructions:
          "Paste into ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows).",
        format: "json",
        config: {
          mcpServers: {
            [serverName]: {
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
      },
      cursor: {
        id: "cursor",
        name: "Cursor",
        target: "cursor",
        filename: ".cursor/mcp.json",
        description: "Cursor IDE remote Streamable HTTP MCP configuration",
        instructions:
          "Paste into .cursor/mcp.json at your workspace root or ~/.cursor/mcp.json globally.",
        format: "json",
        config: {
          mcpServers: {
            [serverName]: {
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
      },
      elizaos: {
        id: "elizaos",
        name: "ElizaOS",
        target: "elizaos",
        filename: "character.json",
        description: "ElizaOS character plugin and MCP settings configuration",
        instructions:
          "Add @elizaos/plugin-mcp to your character plugins and configure the server under settings.mcp.servers.",
        format: "json",
        config: {
          name: options.agentName || "Liege Agent",
          plugins: ["@elizaos/plugin-mcp"],
          settings: {
            mcp: {
              servers: {
                [serverName]: {
                  url,
                  headers: { Authorization: `Bearer ${token}` },
                },
              },
            },
          },
        },
      },
      hermes: {
        id: "hermes",
        name: "Hermes",
        target: "hermes",
        filename: "hermes.json",
        description: "Hermes autonomous agent harness tool configuration",
        instructions: "Add to your hermes.json or config.json under mcpServers.",
        format: "json",
        config: {
          mcpServers: {
            [serverName]: {
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
      },
      openclaw: {
        id: "openclaw",
        name: "OpenClaw",
        target: "openclaw",
        filename: "openclaw.json",
        description: "OpenClaw autonomous agent harness configuration",
        instructions: "Add to your OpenClaw agent configuration under tools.mcp.",
        format: "json",
        config: {
          tools: {
            mcp: {
              [serverName]: {
                url,
                headers: { Authorization: `Bearer ${token}` },
              },
            },
          },
        },
      },
    };
  }

  exportPresets(serverName = "liege", agentName?: string): Record<McpHarnessTarget, McpHarnessPreset> {
    return McpClient.generatePresets({
      serverName,
      serverUrl: this.baseUrl,
      token: this.connectionToken,
      agentName,
    });
  }

  private async initialize() { if (this.initialized) return; await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "@liegeagents/agent-sdk", version: SDK_VERSION } }); await this.rpc("notifications/initialized"); this.initialized = true; }
  private async tool(name: string, arguments_: Record<string, unknown> = {}) { await this.initialize(); const result = await this.rpc("tools/call", { name, arguments: arguments_ }) as { content?: { type: string; text?: string }[] }; const text = result.content?.find((item) => item.type === "text")?.text; return text ? JSON.parse(text) : result; }
  private async rpc(method: string, params: Record<string, unknown> = {}) { const response = await this.request(`${this.baseUrl.replace(/\/$/, "")}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${this.connectionToken}`, Accept: "application/json, text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }) }); if (!response.ok) throw new Error(`MCP request failed (${response.status})`); if (response.status === 202) return {}; const body = await response.json() as { result?: unknown; error?: { message?: string } }; if (body.error) throw new Error(body.error.message ?? "MCP request failed"); return body.result ?? body; }
}
