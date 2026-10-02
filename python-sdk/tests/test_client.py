import httpx

from liege_agent_sdk import LiegeClient, encode_x402_json


def test_authentication_and_job_mapping():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/nonce"):
            return httpx.Response(201, json={"data": {"nonce": "abc", "message": "sign me"}})
        if request.url.path.endswith("/auth/verify"):
            return httpx.Response(200, json={"data": {"token": "session", "userId": "u1", "walletAddress": "0xabc"}})
        if request.url.path.endswith("/jobs"):
            return httpx.Response(200, json={"data": [{"id": "j1", "status": "open", "title": "Research"}]})
        raise AssertionError(request.url)

    with LiegeClient("https://api.test", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        session = client.authenticate("0xabc", lambda message: "0xsigned")
        assert session.token == "session"
        assert client.list_jobs()[0].id == "j1"


def test_x402_challenge_retries_with_application_signature():
    challenge = {"x402Version": 2, "accepts": [{"scheme": "exact", "network": "eip155:4663"}]}
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(402, headers={"PAYMENT-REQUIRED": encode_x402_json(challenge)})
        assert request.headers["PAYMENT-SIGNATURE"] == encode_x402_json({"payload": "signed"})
        return httpx.Response(200, json={"paid": True})

    with LiegeClient("https://api.test", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        response = client.request_x402("https://api.test/resource", lambda value: {"payload": "signed"})
        assert response.json() == {"paid": True}
        assert calls == 2


def test_x402_does_not_forward_liege_token_to_external_resource():
    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers
        return httpx.Response(200, json={"ok": True})

    with LiegeClient("https://api.test", token="session",
                     client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        response = client.request_x402("https://merchant.test/resource", lambda _: {"payload": "signed"})
        assert response.json() == {"ok": True}


def test_event_stream_reconnects_with_cursor_and_deduplicates():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(200, text='id: 1\nevent: job.funded\ndata: {"jobId":"j1"}\n\n')
        return httpx.Response(
            200,
            text='id: 1\nevent: job.funded\ndata: {"jobId":"j1"}\n\nid: 2\nevent: job.completed\ndata: {"jobId":"j1"}\n\n',
        )

    with LiegeClient("https://api.test", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        stream = client.stream_events("agent-1", max_retries=1, backoff_seconds=0)
        first, second = next(stream), next(stream)
        stream.close()

    assert [first.id, second.id] == ["1", "2"]
    assert calls[1].url.params["after"] == "1"
    assert calls[1].headers["last-event-id"] == "1"


def test_service_catalog_maps_rows_and_publishes_service():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            assert request.url.params["type"] == "skill"
            return httpx.Response(200, json={"data": [{
                "id": "svc-1", "agent_id": "agent-1", "slug": "research",
                "name": "Research", "description": "A research service for agents.",
                "service_type": "skill", "execution_mode": "sandboxed_runner",
                "price_usd": "2.50", "sla_minutes": 30,
                "requirements_schema": {}, "deliverable_schema": {},
            }]})
        assert request.method == "POST"
        body = request.read()
        assert b'"serviceType":"tool"' in body
        return httpx.Response(201, json={"data": {
            "id": "svc-2", "agentId": "agent-1", "slug": "lookup",
            "name": "Lookup", "description": "A lookup service for agents.",
            "serviceType": "tool", "executionMode": "manual", "priceUsd": 1,
            "slaMinutes": 15, "requirementsSchema": {}, "deliverableSchema": {},
        }})

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        service = client.list_services(service_type="skill")[0]
        created = client.create_service("agent-1", "lookup", "Lookup", "A lookup service for agents.", "tool", 1, 15)
    assert service.execution_mode == "sandboxed_runner"
    assert service.price_usd == 2.5
    assert created.service_type == "tool"
