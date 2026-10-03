import httpx

from liege_agent_sdk import McpClient


def test_mcp_proposal():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer lmp_test"
        import json
        calls.append(json.loads(request.content)["method"])
        if len(calls) == 1:
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {}})
        if len(calls) == 2:
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 2, "result": {}})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 3, "result": {
            "content": [{"type": "text", "text": json.dumps({"id": "p1", "status": "pending"})}],
        }})

    with McpClient("lmp_test", "https://mcp.test", httpx.Client(transport=httpx.MockTransport(handler))) as client:
        proposal = client.propose("accept_job", {"jobId": "j1"})
        assert proposal.status == "pending"
        assert calls == ["initialize", "notifications/initialized", "tools/call"]


def test_harness_presets():
    with McpClient("lmp_secret123", "https://mcp.custom.io") as client:
        presets = client.export_presets("Research Agent", "Research Agent")
        assert set(presets.keys()) == {"claude_desktop", "cursor", "elizaos", "hermes", "openclaw"}
        assert presets["claude_desktop"].filename == "claude_desktop_config.json"
        assert presets["claude_desktop"].config["mcpServers"]["research-agent"]["headers"]["Authorization"] == "Bearer lmp_secret123"
        assert presets["cursor"].filename == ".cursor/mcp.json"
        assert presets["cursor"].config["mcpServers"]["research-agent"]["url"] == "https://mcp.custom.io/mcp"
        assert "@elizaos/plugin-mcp" in presets["elizaos"].config["plugins"]
        assert presets["hermes"].config["mcpServers"]["research-agent"]["headers"]["Authorization"] == "Bearer lmp_secret123"
        assert presets["openclaw"].config["tools"]["mcp"]["research-agent"]["headers"]["Authorization"] == "Bearer lmp_secret123"


def test_cursor_events_and_bounded_wait():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json
        payload = json.loads(request.content)
        calls.append(payload["method"])
        if payload["method"] == "tools/call":
            name = payload["params"]["name"]
            value = (
                {"items": [{"id": "evt-1", "cursor": "42", "eventType": "job.funded", "payload": {"jobId": "job-1"}}], "nextCursor": "42"}
                if name == "list_job_events"
                else {"event": None, "timedOut": True, "cursor": "42"}
            )
            return httpx.Response(200, json={"result": {"content": [{"type": "text", "text": json.dumps(value)}]}})
        return httpx.Response(200, json={"result": {}})

    with McpClient("lmp_test", "https://mcp.test", httpx.Client(transport=httpx.MockTransport(handler))) as client:
        page = client.list_job_events(after="41", limit=10)
        assert page.items[0].event_type == "job.funded"
        assert page.next_cursor == "42"
        waited = client.wait_for_job_event("42", timeout_ms=500)
        assert waited.timed_out is True
        assert calls == ["initialize", "notifications/initialized", "tools/call", "tools/call"]
