import asyncio
import json

import httpx

from liege_agent_sdk import AsyncLiegeClient, LiegeAPIError, LiegeClient, encode_x402_json


def test_transport_retries_gets_and_preserves_request_id():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, headers={"x-request-id": "req-42"}, json={"error": {"message": "upstream", "code": "UPSTREAM"}})

    with LiegeClient("https://api.test", max_retries=1, retry_backoff=0,
                     client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        try:
            client.list_jobs()
        except LiegeAPIError as error:
            assert error.request_id == "req-42"
            assert error.retryable is True
        else:
            raise AssertionError("expected LiegeAPIError")
    assert calls == 2


def test_async_client_supports_context_manager_and_typed_jobs():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "j1", "status": "open", "title": "Test"}]})

    async def run() -> None:
        async with AsyncLiegeClient("https://api.test", client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as client:
            jobs = await client.list_jobs()
            assert jobs[0].id == "j1"

    asyncio.run(run())


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


def test_list_jobs_filters_by_settlement_asset():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.params["settlementAsset"] == "liege"
        return httpx.Response(200, json={"data": []})

    with LiegeClient("https://api.test", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        assert client.list_jobs(settlement_asset="liege") == []


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
                "requirements_schema": {}, "deliverable_schema": {}, "settlement_assets": ["liege"],
            }]})
        assert request.method == "POST"
        body = request.read()
        assert b'"serviceType":"tool"' in body
        assert b'"settlementAssets":["liege"]' in body
        return httpx.Response(201, json={"data": {
            "id": "svc-2", "agentId": "agent-1", "slug": "lookup",
            "name": "Lookup", "description": "A lookup service for agents.",
            "serviceType": "tool", "executionMode": "manual", "priceUsd": 1,
            "slaMinutes": 15, "requirementsSchema": {}, "deliverableSchema": {}, "settlementAssets": ["liege"],
        }})

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        service = client.list_services(service_type="skill")[0]
        created = client.create_service("agent-1", "lookup", "Lookup", "A lookup service for agents.", "tool", 1, 15, settlement_assets=["liege"])
    assert service.execution_mode == "sandboxed_runner"
    assert service.price_usd == 2.5
    assert service.settlement_assets == ["liege"]
    assert created.service_type == "tool"


def test_service_min_price_can_be_set_and_cleared():
    seen: list[tuple[str, str, bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.content))
        body = json.loads(request.content)
        return httpx.Response(200, json={"data": {
            "id": "svc-1", "price_usd": "5.000000",
            "min_price_usd": None if body["minPriceUsd"] is None else str(body["minPriceUsd"]),
        }})

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        assert client.set_service_min_price("svc-1", 4) == {"id": "svc-1", "price_usd": 5.0, "min_price_usd": 4.0}
        assert client.set_service_min_price("svc-1", None)["min_price_usd"] is None
    assert [(m, p) for m, p, _ in seen] == [("PATCH", "/v1/services/svc-1/min-price")] * 2
    assert json.loads(seen[0][2]) == {"minPriceUsd": 4}


def test_agent_reputation_audit_is_typed():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/agents/anna/reputation"
        return httpx.Response(200, json={"data": {
            "agent": {"slug": "anna", "name": "Anna"},
            "jobs": {"total": 3, "completed": 2},
            "auditDigest": "sha256:test",
            "auditedAt": "2026-10-04T00:00:00Z",
        }})

    with LiegeClient("https://api.test", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        audit = client.get_agent_reputation("anna")
    assert audit.agent["name"] == "Anna"
    assert audit.jobs["completed"] == 2


def test_decline_job_requests_refund():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/jobs/job-1/decline"
        assert json.loads(request.content) == {"reason": "The deadline is too short."}
        return httpx.Response(200, json={"data": {"id": "job-1", "status": "rejected", "title": "Research"}})

    with LiegeClient("https://api.test", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        job = client.decline_job("job-1", "The deadline is too short.")
    assert job.status == "rejected"


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


def test_agent_mandates_and_ap2_export():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/mandates/man-1/ap2"):
            return httpx.Response(200, json={
                "data": {
                    "protocol": "ap2",
                    "version": "0.2",
                    "mandate_id": "man-1",
                    "agent_id": "agent-1",
                    "ap2.mandates.PaymentMandate": {
                        "constraints": {"currency": "USDG", "allowed_assets": ["USDG", "LIEGE"]},
                    },
                },
            })
        if request.url.path.endswith("/mandates"):
            return httpx.Response(200, json={
                "data": [{
                    "id": "man-1",
                    "agentId": "agent-1",
                    "nonce": "nonce-1",
                    "digest": "dig-1",
                    "payload": {"actions": ["rebalance"]},
                    "signature": "0x123",
                    "status": "active",
                    "expiresAt": "2026-10-03T00:00:00Z",
                    "createdAt": "2026-10-02T00:00:00Z",
                }],
            })
        raise AssertionError(request.url)

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        mandates = client.list_agent_mandates("agent-1")
        assert len(mandates) == 1
        assert mandates[0].id == "man-1"
        assert mandates[0].nonce == "nonce-1"

        ap2 = client.export_agent_mandate_ap2("agent-1", "man-1")
        assert ap2["protocol"] == "ap2"
        assert ap2["version"] == "0.2"
        assert ap2["mandate_id"] == "man-1"


def test_super_agent_schedule_lifecycle():
    requests = []
    schedule = {
        "id": "schedule-1", "agent_id": "agent-1", "agent_name": "Anna",
        "request": "Research agent markets", "settlement_asset": "liege",
        "budget_amount": "5", "cadence": "weekly", "starts_at": "2026-10-12T00:00:00Z",
        "next_run_at": "2026-10-12T00:00:00Z", "spend_cap": "15", "committed_amount": "0",
        "max_runs": 3, "runs_count": 0, "auto_fund": False, "status": "active",
        "status_reason": None, "source": "dashboard", "created_at": "2026-10-11T00:00:00Z",
        "updated_at": "2026-10-11T00:00:00Z", "runs": [{
            "id": "run-1", "slot": "2026-10-12T00:00:00Z", "outcome": "awaiting_funding",
            "detail": "Auto-funding is off.", "created_at": "2026-10-11T00:00:00Z",
            "job_id": "job-1", "job_status": "open",
        }],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        if request.url.path.endswith("/schedules") and request.method == "GET":
            return httpx.Response(200, json={"data": [schedule]})
        return httpx.Response(201 if request.method == "POST" else 200, json={"data": schedule})

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        created = client.create_super_agent_schedule(
            "agent-1", "Research agent markets", 5, "weekly", 15,
            settlement_asset="liege", max_runs=3, auto_fund=False,
        )
        assert created.agent_id == "agent-1"
        assert created.settlement_asset == "liege"
        assert created.runs[0].slot == "2026-10-12T00:00:00Z"
        assert client.list_super_agent_schedules()[0].id == "schedule-1"
        assert client.get_super_agent_schedule("schedule-1").id == "schedule-1"
        client.pause_super_agent_schedule("schedule-1")
        client.resume_super_agent_schedule("schedule-1")
        client.cancel_super_agent_schedule("schedule-1")

    assert requests[0] == ("POST", "/v1/super-agents/schedules", {
        "agentId": "agent-1", "request": "Research agent markets", "budgetAmount": 5,
        "cadence": "weekly", "spendCap": 15, "settlementAsset": "liege",
        "autoFund": False, "source": "dashboard", "maxRuns": 3,
    })
    assert [(method, path) for method, path, _ in requests[1:]] == [
        ("GET", "/v1/super-agents/schedules"),
        ("GET", "/v1/super-agents/schedules/schedule-1"),
        ("POST", "/v1/super-agents/schedules/schedule-1/pause"),
        ("POST", "/v1/super-agents/schedules/schedule-1/resume"),
        ("DELETE", "/v1/super-agents/schedules/schedule-1"),
    ]


def test_async_super_agent_schedule_helpers():
    schedule = {
        "id": "schedule-1", "agent_id": "agent-1", "agent_name": "Anna",
        "request": "Research", "settlement_asset": "usdg", "budget_amount": "5",
        "cadence": "daily", "starts_at": "2026-10-12T00:00:00Z", "next_run_at": None,
        "spend_cap": "10", "committed_amount": "0", "max_runs": None,
        "runs_count": 0, "auto_fund": False, "status": "active", "status_reason": None,
        "source": "dashboard", "created_at": "2026-10-11T00:00:00Z",
        "updated_at": "2026-10-11T00:00:00Z", "runs": [],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"data": schedule})

    async def run() -> None:
        async with AsyncLiegeClient("https://api.test", token="session", client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )) as client:
            created = await client.create_super_agent_schedule(
                "agent-1", "Research", 5, "daily", 10
            )
            assert created.id == "schedule-1"
            paused = await client.pause_super_agent_schedule("schedule-1")
            assert paused.status == "active"

    asyncio.run(run())


def test_super_agent_watchlist():
    requests = []
    watch = {
        "id": "watch-1", "watch_token": "0x1111111111111111111111111111111111111111",
        "watch_chain": "base", "chain_name": "Base", "agent_id": "agent-constantine",
        "agent_name": "Constantine", "settlement_asset": "usdg", "budget_amount": "0.5",
        "next_run_at": "2026-10-21T00:00:00Z", "spend_cap": "15", "committed_amount": "1",
        "max_runs": None, "runs_count": 2, "auto_fund": True, "status": "active",
        "status_reason": None, "source": "cli", "created_at": "2026-10-19T00:00:00Z",
        "updated_at": "2026-10-20T00:00:00Z", "runs": [{
            "id": "run-2", "slot": "2026-10-20T00:00:00Z", "outcome": "funded", "detail": None,
            "created_at": "2026-10-20T00:00:00Z", "job_id": "job-2", "job_status": "submitted",
            "verdict": "high risk", "risk_score": 72, "baseline": False,
            "changes": [{"signal": "liquidity", "label": "Liquidity", "detail": "Liquidity fell by 60%."}],
            "checked_at": "2026-10-20T00:05:00Z",
        }, {
            "id": "run-1", "slot": "2026-10-19T00:00:00Z", "outcome": "awaiting_funding",
            "detail": "Auto-funding is off.", "created_at": "2026-10-19T00:00:00Z", "job_id": "job-1",
            "job_status": "open", "verdict": None, "risk_score": None, "baseline": None,
            "changes": [], "checked_at": None,
        }],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        if request.url.path.endswith("/watchlist") and request.method == "GET":
            return httpx.Response(200, json={"data": [watch]})
        return httpx.Response(201 if request.method == "POST" else 200, json={"data": watch})

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        created = client.create_super_agent_watch(
            "0x1111111111111111111111111111111111111111", chain="base", source="cli",
        )
        assert created.watch_token == "0x1111111111111111111111111111111111111111"
        assert created.chain_name == "Base"
        assert created.budget_amount == "0.5"
        latest, first = created.runs
        assert (latest.verdict, latest.risk_score, latest.baseline) == ("high risk", 72, False)
        assert latest.changes[0].signal == "liquidity"
        assert latest.changes[0].detail == "Liquidity fell by 60%."
        assert (first.verdict, first.risk_score, first.changes) == (None, None, [])
        assert client.list_super_agent_watchlist()[0].watch_chain == "base"
        assert client.get_super_agent_watch("watch-1").id == "watch-1"

    assert requests[0] == ("POST", "/v1/super-agents/watchlist", {
        "token": "0x1111111111111111111111111111111111111111", "chain": "base",
        "settlementAsset": "usdg", "autoFund": False, "source": "cli",
    })
    assert [(method, path) for method, path, _ in requests[1:]] == [
        ("GET", "/v1/super-agents/watchlist"),
        ("GET", "/v1/super-agents/watchlist/watch-1"),
    ]


def test_schedules_carry_the_watched_token():
    base = {"id": "s", "agent_id": "a", "cadence": "daily", "status": "active", "runs": []}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [
            {**base, "watch_token": None, "watch_chain": None},
            {**base, "watch_token": "0x2222222222222222222222222222222222222222", "watch_chain": "bsc"},
        ]})

    with LiegeClient("https://api.test", token="session", client=httpx.Client(transport=httpx.MockTransport(handler))) as client:
        ordinary, watched = client.list_super_agent_schedules()
    assert (ordinary.watch_token, ordinary.watch_chain) == (None, None)
    assert (watched.watch_token, watched.watch_chain) == ("0x2222222222222222222222222222222222222222", "bsc")


def test_async_super_agent_watch_helpers():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        return httpx.Response(201, json={"data": {
            "id": "watch-1", "watch_token": "0x1111111111111111111111111111111111111111",
            "watch_chain": "robinhood", "chain_name": "Robinhood Chain", "status": "active", "runs": [],
        }})

    async def run() -> None:
        async with AsyncLiegeClient("https://api.test", token="session", client=httpx.AsyncClient(
            transport=httpx.MockTransport(handler)
        )) as client:
            created = await client.create_super_agent_watch(
                "0x1111111111111111111111111111111111111111", budget_amount=2, spend_cap=10,
            )
            assert created.chain_name == "Robinhood Chain"
            assert (await client.get_super_agent_watch("watch-1")).id == "watch-1"

    asyncio.run(run())
    assert seen[0] == ("POST", "/v1/super-agents/watchlist", {
        "token": "0x1111111111111111111111111111111111111111", "chain": "robinhood",
        "settlementAsset": "usdg", "autoFund": False, "source": "dashboard",
        "budgetAmount": 2, "spendCap": 10,
    })
    assert seen[1][:2] == ("GET", "/v1/super-agents/watchlist/watch-1")
