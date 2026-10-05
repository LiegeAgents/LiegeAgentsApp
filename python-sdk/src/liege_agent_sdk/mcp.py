from typing import Any

import httpx

from .models import Job, McpEvent, McpEventPage, McpEventWait, McpExecutionGrant, McpProposal, McpHarnessPreset


class McpClient:
    """Client for a connection-scoped Liege MCP service session."""

    def __init__(self, connection_token: str, base_url: str = "https://mcp.liegeagents.com",
                 client: httpx.Client | None = None):
        self.connection_token = connection_token
        self.base_url = base_url.rstrip("/")
        self._http = client or httpx.Client(timeout=30)
        self._request_id = 0
        self._initialized = False

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "McpClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _rpc(self, method: str, params: dict[str, Any] | None = None) -> Any:
        self._request_id += 1
        response = self._http.post(
            f"{self.base_url}/mcp",
            json={"jsonrpc": "2.0", "id": self._request_id, "method": method, "params": params or {}},
            headers={
                "Authorization": f"Bearer {self.connection_token}",
                "Accept": "application/json, text/event-stream",
            },
        )
        if response.is_error:
            body = response.json()
            raise RuntimeError(body.get("error", {}).get("message", "MCP request failed."))
        if response.status_code == 202 or not response.content:
            return {}
        body = response.json()
        if "error" in body:
            raise RuntimeError(body["error"].get("message", "MCP request failed."))
        return body.get("result", body)

    def _initialize(self) -> None:
        if self._initialized:
            return
        self._rpc("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "liege-agent-sdk", "version": "0.1.0"},
        })
        self._rpc("notifications/initialized")
        self._initialized = True

    def _tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        self._initialize()
        result = self._rpc("tools/call", {"name": name, "arguments": arguments or {}})
        content = result.get("content", []) if isinstance(result, dict) else []
        text = next((item.get("text") for item in content if item.get("type") == "text"), None)
        if text is None:
            return result
        import json
        return json.loads(text)

    def session(self) -> dict[str, Any]:
        return self._tool("get_agent_profile")

    def list_jobs(self) -> list[Job]:
        value = self._tool("list_agent_jobs")
        jobs = value.get("jobs", value) if isinstance(value, dict) else value
        return [Job.from_dict(item) for item in jobs]

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self._tool("get_job_details", {"jobId": job_id})

    def list_job_events(self, after: str | None = None, limit: int = 50) -> McpEventPage:
        arguments: dict[str, Any] = {"limit": limit}
        if after is not None:
            arguments["after"] = after
        value = self._tool("list_job_events", arguments)
        return McpEventPage(
            [McpEvent.from_dict(item) for item in value.get("items", [])],
            value.get("nextCursor"),
        )

    def wait_for_job_event(self, after: str, timeout_ms: int = 30_000, poll_ms: int = 2_000) -> McpEventWait:
        value = self._tool("wait_for_job_event", {
            "after": after,
            "timeoutMs": timeout_ms,
            "pollMs": poll_ms,
        })
        event = value.get("event")
        return McpEventWait(
            McpEvent.from_dict(event) if isinstance(event, dict) else None,
            bool(value.get("timedOut", False)),
            value.get("cursor"),
        )

    def propose(self, action: str, payload: dict[str, Any]) -> McpProposal:
        value = self._tool("propose_action", {"action": action, "payload": payload})
        return McpProposal(value["id"], value["status"], None, value)

    def get_execution_grant(self, proposal_id: str) -> McpExecutionGrant:
        return McpExecutionGrant.from_dict(self._tool("get_execution_grant", {"proposalId": proposal_id}))

    def submit_granted_deliverable(
        self, grant_token: str, job_id: str, deliverable: str, evidence: list[str] | None = None
    ) -> Job:
        value = self._tool("submit_granted_deliverable", {
            "grantToken": grant_token,
            "jobId": job_id,
            "deliverable": deliverable,
            "evidence": evidence or [],
        })
        return Job.from_dict(value)

    def account_status(self) -> dict[str, Any]:
        return self._tool("liege_account_status")

    def account_simulate(self, action: str, amount: float | None = None, asset: str | None = None,
                         venue: str | None = None, counterparty: str | None = None,
                         details: dict[str, Any] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"action": action}
        if amount is not None:
            payload["amount"] = amount
        if asset is not None:
            payload["asset"] = asset
        if venue is not None:
            payload["venue"] = venue
        if counterparty is not None:
            payload["counterparty"] = counterparty
        if details is not None:
            payload["details"] = details
        return self._tool("liege_account_simulate", payload)

    def account_authorize(self, action: str, amount: float | None = None, asset: str | None = None,
                          venue: str | None = None, counterparty: str | None = None,
                          details: dict[str, Any] | None = None,
                          simulation_id: str | None = None,
                          simulation_digest: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"action": action}
        if amount is not None:
            payload["amount"] = amount
        if asset is not None:
            payload["asset"] = asset
        if venue is not None:
            payload["venue"] = venue
        if counterparty is not None:
            payload["counterparty"] = counterparty
        if details is not None:
            payload["details"] = details
        if simulation_id is not None:
            payload["simulationId"] = simulation_id
        if simulation_digest is not None:
            payload["simulationDigest"] = simulation_digest
        return self._tool("liege_account_authorize", payload)

    def account_mandates(self) -> list[dict[str, Any]]:
        value = self._tool("liege_account_mandates")
        if isinstance(value, dict) and "mandates" in value:
            return value["mandates"]
        return value if isinstance(value, list) else []

    def list_services(self, limit: int | None = None, cursor: str | None = None,
                      settlement_asset: str | None = None) -> list[dict[str, Any]]:
        arguments: dict[str, Any] = {}
        if limit is not None:
            arguments["limit"] = limit
        if cursor is not None:
            arguments["cursor"] = cursor
        if settlement_asset is not None:
            arguments["settlementAsset"] = settlement_asset
        value = self._tool("list_services", arguments)
        if isinstance(value, dict) and "services" in value:
            return value["services"]
        return value if isinstance(value, list) else []

    @staticmethod
    def generate_presets(server_name: str | None = None, server_url: str | None = None,
                         token: str | None = None, agent_name: str | None = None) -> dict[str, McpHarnessPreset]:
        import re
        effective_token = token or "<YOUR_LIEGE_MCP_TOKEN>"
        raw_name = (server_name or agent_name or "liege").lower()
        cleaned_name = re.sub(r"[^a-z0-9_-]+", "-", raw_name).strip("-") or "liege"
        url = (server_url or "https://mcp.liegeagents.com").rstrip("/") + "/mcp"

        return {
            "claude_desktop": McpHarnessPreset(
                id="claude_desktop",
                name="Claude Desktop",
                target="claude_desktop",
                filename="claude_desktop_config.json",
                description="Claude Desktop app MCP server configuration",
                instructions="Paste into ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows).",
                format="json",
                config={"mcpServers": {cleaned_name: {"url": url, "headers": {"Authorization": f"Bearer {effective_token}"}}}},
            ),
            "cursor": McpHarnessPreset(
                id="cursor",
                name="Cursor",
                target="cursor",
                filename=".cursor/mcp.json",
                description="Cursor IDE remote Streamable HTTP MCP configuration",
                instructions="Paste into .cursor/mcp.json at your workspace root or ~/.cursor/mcp.json globally.",
                format="json",
                config={"mcpServers": {cleaned_name: {"url": url, "headers": {"Authorization": f"Bearer {effective_token}"}}}},
            ),
            "elizaos": McpHarnessPreset(
                id="elizaos",
                name="ElizaOS",
                target="elizaos",
                filename="character.json",
                description="ElizaOS character plugin and MCP settings configuration",
                instructions="Add @elizaos/plugin-mcp to your character plugins and configure the server under settings.mcp.servers.",
                format="json",
                config={
                    "name": agent_name or "Liege Agent",
                    "plugins": ["@elizaos/plugin-mcp"],
                    "settings": {"mcp": {"servers": {cleaned_name: {"url": url, "headers": {"Authorization": f"Bearer {effective_token}"}}}}},
                },
            ),
            "hermes": McpHarnessPreset(
                id="hermes",
                name="Hermes",
                target="hermes",
                filename="hermes.json",
                description="Hermes autonomous agent harness tool configuration",
                instructions="Add to your hermes.json or config.json under mcpServers.",
                format="json",
                config={"mcpServers": {cleaned_name: {"url": url, "headers": {"Authorization": f"Bearer {effective_token}"}}}},
            ),
            "openclaw": McpHarnessPreset(
                id="openclaw",
                name="OpenClaw",
                target="openclaw",
                filename="openclaw.json",
                description="OpenClaw autonomous agent harness configuration",
                instructions="Add to your OpenClaw agent configuration under tools.mcp.",
                format="json",
                config={"tools": {"mcp": {cleaned_name: {"url": url, "headers": {"Authorization": f"Bearer {effective_token}"}}}}},
            ),
        }

    def export_presets(self, server_name: str = "liege", agent_name: str | None = None) -> dict[str, McpHarnessPreset]:
        return self.generate_presets(
            server_name=server_name,
            server_url=self.base_url,
            token=self.connection_token,
            agent_name=agent_name,
        )
