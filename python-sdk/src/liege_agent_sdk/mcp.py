from typing import Any

import httpx

from .models import Job, McpProposal


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

    def propose(self, action: str, payload: dict[str, Any]) -> McpProposal:
        value = self._tool("propose_action", {"action": action, "payload": payload})
        return McpProposal(value["id"], value["status"], None, value)

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

    def list_services(self) -> list[dict[str, Any]]:
        value = self._tool("list_services")
        if isinstance(value, dict) and "services" in value:
            return value["services"]
        return value if isinstance(value, list) else []
