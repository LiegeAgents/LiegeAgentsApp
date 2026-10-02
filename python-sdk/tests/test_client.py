import json

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


def test_agent_account_controls_bind_authorization_to_simulation():
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        path = request.url.path
        if path.endswith("/agent-accounts/agent-1"):
            return httpx.Response(200, json={"data": {"accountId": "agent-1", "agentId": "agent-1", "status": "active", "policy": {"version": 2, "simulationRequired": True, "approvalMode": "always", "allowedAssets": []}}})
        if path.endswith("/actions/simulate"):
            return httpx.Response(201, json={"data": {"id": "sim-1", "action_digest": "digest-1234", "action": {"action": "run"}, "result": {"eligible": True}, "policy_version": 2, "expires_at": "2030-01-01T00:00:00Z", "created_at": "2030-01-01T00:00:00Z"}})
        if path.endswith("/actions/authorize"):
            return httpx.Response(200, json={"data": {"actionId": "action-1", "accountId": "agent-1", "decision": "approval_required", "reasons": [], "policyVersion": 2, "simulationDigest": "digest-1234", "createdAt": "2030-01-01T00:00:00Z"}})
        raise AssertionError(path)

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        account = client.get_account("agent-1")
        simulation = client.simulate_action("agent-1", {"action": "run", "amount": 1})
        authorization = client.authorize_action("agent-1", {"action": "run", "amount": 1, "simulationId": simulation.id})
    assert account.policy.version == 2
    assert simulation.action_digest == "digest-1234"
    assert authorization.decision == "approval_required"
    assert calls[2].method == "POST"


def test_partial_refund_and_list_refunds():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/invoices/inv-1/refund"):
            assert request.method == "POST"
            body = json.loads(request.read())
            assert body == {"amount": 5.0, "jobId": "job-1", "reason": "Milestone adjust"}
            return httpx.Response(200, json={"data": {
                "id": "inv-1", "publicId": "INV-1", "amount": 10.0, "amountUsdg": 10.0,
                "refundedAmount": 5.0, "refundedAmountUsdg": 5.0, "remainingAmount": 5.0,
                "asset": "usdg", "status": "partially_refunded",
            }})
        if request.url.path.endswith("/invoices/inv-1/refunds"):
            assert request.method == "GET"
            return httpx.Response(200, json={"data": [{
                "id": "ref-1", "invoiceId": "inv-1", "payerId": "p-1", "issuerId": "iss-1",
                "amount": 5.0, "amountUsdg": 5.0, "asset": "usdg", "jobId": "job-1",
                "reason": "Milestone adjust", "refundedAt": "2026-10-02T12:00:00Z",
                "ledgerTransactionId": "tx-1",
            }]})
        raise AssertionError(request.url)

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        refunded = client.refund_invoice("inv-1", amount=5.0, job_id="job-1", reason="Milestone adjust")
        assert refunded.status == "partially_refunded"
        assert refunded.refunded_amount == 5.0
        assert refunded.remaining_amount == 5.0

        refunds = client.list_invoice_refunds("inv-1")
        assert len(refunds) == 1
        assert refunds[0].amount == 5.0
        assert refunds[0].job_id == "job-1"
        assert refunds[0].reason == "Milestone adjust"

def test_list_receipts_and_otel_export():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/receipts") and request.url.params.get("format") == "otel":
            return httpx.Response(200, json={
                "resourceSpans": [{
                    "resource": {"attributes": [{"key": "service.name", "value": {"stringValue": "liege"}}]},
                    "scopeSpans": [{"spans": [{"traceId": "0" * 32, "name": "ledger.invoice_payment"}]}],
                }],
                "digest": "a" * 64,
            })
        if request.url.path.endswith("/receipts"):
            return httpx.Response(200, json={
                "data": [{
                    "receiptId": "rec-1", "type": "invoice_payment", "reference": "ref-1",
                    "createdAt": "2026-10-02T12:00:00Z", "asset": "usdg", "availableChange": "-10",
                }],
                "digest": "a" * 64,
            })
        raise AssertionError(request.url)

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        receipts = client.list_receipts()
        assert len(receipts) == 1
        assert receipts[0].receipt_id == "rec-1"
        assert receipts[0].type == "invoice_payment"

        otel = client.list_receipts(format="otel")
        assert "resourceSpans" in otel
        assert otel["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["name"] == "ledger.invoice_payment"

