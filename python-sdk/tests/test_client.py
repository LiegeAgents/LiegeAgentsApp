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
