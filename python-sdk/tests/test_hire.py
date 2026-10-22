import json

import httpx
import pytest

from liege_agent_sdk import LiegeAPIError, LiegeClient, LiegeHireClient


def task(state, **extra):
    return {"kind": "task", "id": "task-1", "contextId": "task-1",
            "status": {"state": state, "message": {"kind": "message", "role": "agent", "parts": [{"kind": "text", "text": f"now {state}"}]}},
            "metadata": {"proposalStatus": "pending" if state == "submitted" else "approved", "jobId": "job-1", "jobStatus": None},
            **extra}


def test_hire_and_wait_for_the_delivered_work():
    seen = []
    states = ["submitted", "working", "completed"]

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append((request.url.path, request.headers.get("authorization"), body))
        if request.url.path == "/.well-known/agent-card.json":
            return httpx.Response(200, json={"skills": [{"id": "scott", "name": "Scott: News brief", "description": "A brief.", "tags": ["verified"]}]})
        if body["method"] == "message/send":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": task("submitted")})
        state = states.pop(0)
        extra = {"artifacts": [{"artifactId": "a", "parts": [{"kind": "text", "text": "# Brief"}]}]} if state == "completed" else {}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": task(state, **extra)})

    with LiegeHireClient("lmh_test", "https://api.test", client=httpx.Client(transport=httpx.MockTransport(handler))) as hire:
        assert hire.agents()[0].id == "scott"
        proposed = hire.hire("Summarize this week's chain news", agent="scott", budget=3)
        assert (proposed.state, proposed.message, proposed.deliverable) == ("submitted", "now submitted", None)
        done = hire.wait_for_result(proposed.id, poll=0)
    assert (done.state, done.deliverable, done.job_id) == ("completed", "# Brief", "job-1")
    path, auth, body = seen[1]
    assert (path, auth) == ("/v1/a2a/scott", "Bearer lmh_test")
    assert body["method"] == "message/send" and body["params"]["metadata"] == {"budgetAmount": 3}
    assert body["params"]["message"]["parts"] == [{"kind": "text", "text": "Summarize this week's chain news"}]
    assert seen[-1][0] == "/v1/a2a" and seen[-1][2]["params"] == {"id": "task-1"}


def test_errors_and_wait_timeout():
    reply = {"jsonrpc": "2.0", "id": 1, "error": {"code": -32602, "message": "This key can propose at most 5 USDG per hire.", "data": {"code": "hire_cap_exceeded"}}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=reply)

    hire = LiegeHireClient("lmh_test", "https://api.test", client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(LiegeAPIError) as error:
        hire.hire("Hire Anna for a scan", budget=9)
    assert (error.value.code, error.value.status) == ("hire_cap_exceeded", 422)
    reply = {"jsonrpc": "2.0", "id": 1, "error": {"code": -32001, "message": "Task not found."}}
    with pytest.raises(LiegeAPIError) as error:
        hire.task("missing")
    assert error.value.status == 404
    reply = {"jsonrpc": "2.0", "id": 1, "result": task("submitted")}
    with pytest.raises(LiegeAPIError) as error:
        hire.wait_for_result("task-1", timeout=0, poll=0)
    assert error.value.code == "hire_wait_timeout"
    with pytest.raises(LiegeAPIError):
        LiegeHireClient("lmp_nope")


def test_hire_keys_on_the_session_client():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(200, json={"data": {"id": "k1", "token": "lmh_x"} if request.method == "POST" else []})

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        assert client.create_hire_key("Bot", 5, 20, expires_in_days=7)["token"] == "lmh_x"
        assert client.list_hire_keys() == []
        client.revoke_hire_key("k1")
    assert seen == [("POST", "/v1/mcp/hire-keys"), ("GET", "/v1/mcp/hire-keys"), ("DELETE", "/v1/mcp/hire-keys/k1")]
