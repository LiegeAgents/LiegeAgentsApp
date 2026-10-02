from __future__ import annotations

import base64
import binascii
import json
import time
from collections.abc import Callable, Iterator
from datetime import datetime
from typing import Any

import httpx

from .errors import LiegeAPIError
from .models import (
    AgentAccount, AgentActionAuthorization, AgentActionInput, AgentActionSimulation, AgentControlResult,
    AgentMandate, AgentPolicyInput, Invoice, InvoiceRefund, Job, JobEvent, Receipt, Service, ServiceType, Session,
)


Signer = Callable[[str], str]
X402Signer = Callable[[dict[str, Any]], str | dict[str, Any]]


class LiegeClient:
    """Synchronous Liege API client.

    A signer is supplied by the application so private keys stay outside the SDK.
    The signer receives the nonce-bound SIWE message and returns a hex signature.
    """

    def __init__(self, base_url: str = "https://api.liegeagents.com", token: str | None = None,
                 client: httpx.Client | None = None):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._http = client or httpx.Client(timeout=30)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "LiegeClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        headers = dict(kwargs.pop("headers", {}))
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        response = self._http.request(method, f"{self.base_url}{path}", headers=headers, **kwargs)
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.is_error:
            error = body.get("error", {}) if isinstance(body, dict) else {}
            raise LiegeAPIError(error.get("message", response.reason_phrase), response.status_code, error.get("code"))
        return body.get("data", body) if isinstance(body, dict) else body

    def authenticate(self, address: str, signer: Signer) -> Session:
        nonce = self._request("POST", "/v1/auth/nonce", json={"address": address})
        signature = signer(nonce["message"])
        value = self._request("POST", "/v1/auth/verify", json={
            "address": address, "nonce": nonce["nonce"], "signature": signature,
        })
        self.token = value["token"]
        return Session(self.token, _date(value.get("expiresAt")), value["userId"], value["walletAddress"])

    def list_jobs(self, status: str | None = None, limit: int = 50) -> list[Job]:
        query: dict[str, Any] = {"limit": limit}
        if status:
            query["status"] = status
        return [Job.from_dict(item) for item in self._request("GET", "/v1/jobs", params=query)]

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/jobs/{job_id}")

    def get_private_payload(self, job_id: str, payload: str) -> dict[str, Any]:
        if payload not in {"brief", "deliverable"}:
            raise ValueError("payload must be 'brief' or 'deliverable'")
        return self._request("GET", f"/v1/jobs/{job_id}/payload/{payload}")

    def submit_deliverable(self, job_id: str, deliverable: str, evidence: list[str] | None = None) -> Job:
        value = self._request("POST", f"/v1/jobs/{job_id}/submit", json={
            "deliverable": deliverable, "evidence": evidence or [],
        })
        return Job.from_dict(value)

    def list_invoices(self) -> list[Invoice]:
        return [Invoice.from_dict(item) for item in self._request("GET", "/v1/invoices")]

    def create_invoice(self, agent_id: str, description: str, amount_usdg: str | float | None = None,
                       expires_at: str | None = None, reference: str | None = None,
                       amount: str | float | None = None, asset: str = "usdg") -> Invoice:
        body: dict[str, Any] = {"agentId": agent_id, "description": description, "asset": asset}
        if expires_at:
            body["expiresAt"] = expires_at
        if amount is not None:
            body["amount"] = amount
        if amount_usdg is not None:
            body["amountUsdg"] = amount_usdg
        if reference:
            body["reference"] = reference
        return Invoice.from_dict(self._request("POST", "/v1/invoices", json=body))

    def pay_invoice(self, invoice_id: str) -> Invoice:
        return Invoice.from_dict(self._request("POST", f"/v1/invoices/{invoice_id}/pay"))

    def refund_invoice(self, invoice_id: str, amount: str | float | None = None,
                       job_id: str | None = None, reason: str | None = None) -> Invoice:
        body: dict[str, Any] = {}
        if amount is not None:
            body["amount"] = amount
        if job_id is not None:
            body["jobId"] = job_id
        if reason is not None:
            body["reason"] = reason
        return Invoice.from_dict(self._request("POST", f"/v1/invoices/{invoice_id}/refund", json=body or None))

    def list_invoice_refunds(self, invoice_id: str) -> list[InvoiceRefund]:
        items = self._request("GET", f"/v1/invoices/{invoice_id}/refunds")
        return [InvoiceRefund.from_dict(item) for item in items]

    def list_receipts(self, format: str = "json", limit: int = 500) -> Any:
        params: dict[str, Any] = {"limit": limit}
        if format:
            params["format"] = format
        res = self._request("GET", "/v1/receipts", params=params)
        if format in ("otel", "csv"):
            return res
        items = res if isinstance(res, list) else (res.get("data", []) if isinstance(res, dict) else [])
        return [Receipt.from_dict(item) for item in items]

    def get_receipt(self, receipt_id: str, format: str = "json") -> Any:
        params = {"format": format} if format != "json" else None
        return self._request("GET", f"/v1/receipts/{receipt_id}", params=params)

    def list_services(self, agent_id: str | None = None, service_type: ServiceType | None = None,
                      limit: int = 50) -> list[Service]:
        params: dict[str, Any] = {"limit": limit}
        if agent_id:
            params["agentId"] = agent_id
        if service_type:
            params["type"] = service_type
        return [Service.from_dict(item) for item in self._request("GET", "/v1/services", params=params)]

    def get_service(self, agent_id: str, slug: str) -> Service:
        return Service.from_dict(self._request("GET", f"/v1/services/{agent_id}/{slug}"))

    def create_service(self, agent_id: str, slug: str, name: str, description: str,
                       service_type: ServiceType, price_usd: str | float, sla_minutes: int,
                       execution_mode: str = "manual", requirements_schema: dict[str, Any] | None = None,
                       deliverable_schema: dict[str, Any] | None = None) -> Service:
        value = self._request("POST", "/v1/services", json={
            "agentId": agent_id, "slug": slug, "name": name, "description": description,
            "serviceType": service_type, "executionMode": execution_mode, "priceUsd": price_usd,
            "slaMinutes": sla_minutes, "requirementsSchema": requirements_schema or {},
            "deliverableSchema": deliverable_schema or {},
        })
        return Service.from_dict(value)

    def get_account(self, agent_id: str) -> AgentAccount:
        return AgentAccount.from_dict(self._request("GET", f"/v1/agent-accounts/{agent_id}"))

    def update_policy(self, agent_id: str, policy: AgentPolicyInput) -> AgentAccount:
        return AgentAccount.from_dict(self._request("PUT", f"/v1/agent-accounts/{agent_id}/policy", json=policy))

    def simulate_action(self, agent_id: str, action: AgentActionInput) -> AgentActionSimulation:
        return AgentActionSimulation.from_dict(self._request("POST", f"/v1/agent-accounts/{agent_id}/actions/simulate", json=action))

    def authorize_action(self, agent_id: str, action: AgentActionInput) -> AgentActionAuthorization:
        return AgentActionAuthorization.from_dict(self._request("POST", f"/v1/agent-accounts/{agent_id}/actions/authorize", json=action))

    def approve_action(self, agent_id: str, action_id: str) -> AgentActionAuthorization:
        return AgentActionAuthorization.from_dict(self._request("POST", f"/v1/agent-accounts/{agent_id}/actions/{action_id}/approve"))

    def _control_account(self, agent_id: str, command: str, reason: str | None = None) -> AgentControlResult:
        body: dict[str, Any] = {"command": command}
        if reason:
            body["reason"] = reason
        return AgentControlResult.from_dict(self._request("POST", f"/v1/agent-accounts/{agent_id}/control", json=body))

    def pause_agent(self, agent_id: str, reason: str | None = None) -> AgentControlResult:
        return self._control_account(agent_id, "pause", reason)

    def resume_agent(self, agent_id: str) -> AgentControlResult:
        return self._control_account(agent_id, "resume")

    def kill_agent(self, agent_id: str, reason: str | None = None) -> AgentControlResult:
        return self._control_account(agent_id, "kill", reason)

    def list_agent_mandates(self, agent_id: str) -> list[AgentMandate]:
        items = self._request("GET", f"/v1/agent-accounts/{agent_id}/mandates")
        return [AgentMandate.from_dict(item) for item in items]

    def get_agent_mandate(self, agent_id: str, mandate_id: str) -> AgentMandate:
        data = self._request("GET", f"/v1/agent-accounts/{agent_id}/mandates/{mandate_id}")
        return AgentMandate.from_dict(data)

    def export_agent_mandate_ap2(self, agent_id: str, mandate_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/agent-accounts/{agent_id}/mandates/{mandate_id}/ap2")


    def request_x402(self, url: str, signer: X402Signer, method: str = "GET", **kwargs: Any) -> httpx.Response:
        """Request an x402 resource and retry once with an app-signed payment authorization.

        The signer owns wallet access and must return either an already encoded
        ``PAYMENT-SIGNATURE`` value or the JSON payload to base64-encode.
        """
        headers = dict(kwargs.pop("headers", {}))
        target = httpx.URL(url)
        base = httpx.URL(self.base_url)
        same_origin = (
            target.scheme == base.scheme
            and target.host == base.host
            and target.port == base.port
        )
        if self.token and same_origin:
            headers["Authorization"] = f"Bearer {self.token}"
        first = self._http.request(method, url, headers=headers, **kwargs)
        if first.status_code != 402:
            return first
        encoded = first.headers.get("PAYMENT-REQUIRED") or first.headers.get("X-PAYMENT-REQUIRED")
        if not encoded:
            raise LiegeAPIError("The x402 response did not include PAYMENT-REQUIRED", 502, "x402_invalid_challenge")
        challenge = decode_x402_payment_required(encoded)
        signed = signer(challenge)
        headers["PAYMENT-SIGNATURE"] = signed if isinstance(signed, str) else encode_x402_json(signed)
        return self._http.request(method, url, headers=headers, **kwargs)

    def iter_events(
        self, agent_id: str, since: datetime | None = None, after: str | None = None
    ) -> Iterator[JobEvent]:
        """Read one SSE connection.

        ``after`` is the durable event cursor returned as ``JobEvent.id``. The
        older ``since`` timestamp remains available for compatibility, but new
        consumers should persist and pass ``after``.
        """
        yield from self._event_connection(agent_id, since=since, after=after)

    def stream_events(
        self,
        agent_id: str,
        *,
        after: str | None = None,
        since: datetime | None = None,
        max_retries: int | None = None,
        backoff_seconds: float = 1.0,
    ) -> Iterator[JobEvent]:
        """Stream events with durable cursor recovery and bounded reconnects.

        The cursor is sent as both ``Last-Event-ID`` and ``?after=``. Events
        with an already-seen id are discarded after reconnecting. Persist each
        yielded event id in the application after processing the event.
        """
        cursor = after
        retries = 0
        seen: set[str] = set()
        while True:
            try:
                for event in self._event_connection(agent_id, since=since if cursor is None else None, after=cursor):
                    if event.id and event.id in seen:
                        continue
                    if event.id:
                        seen.add(event.id)
                        if len(seen) > 2048:
                            seen = set(list(seen)[-1024:])
                        cursor = event.id
                    yield event
                retries = 0
                since = None
                if max_retries == 0:
                    return
            except (httpx.HTTPError, LiegeAPIError) as error:
                if isinstance(error, LiegeAPIError) and error.status < 500:
                    raise
                if max_retries is not None and retries >= max_retries:
                    raise
            retries += 1
            time.sleep(min(30.0, backoff_seconds * (2 ** min(retries - 1, 5))))

    def _event_connection(
        self, agent_id: str, *, since: datetime | None = None, after: str | None = None
    ) -> Iterator[JobEvent]:
        params: dict[str, str] = {}
        if after is not None:
            params["after"] = after
        elif since is not None:
            params["since"] = since.isoformat()
        headers = self._headers()
        if after is not None:
            headers["Last-Event-ID"] = after
        with self._http.stream("GET", f"{self.base_url}/v1/webhooks/stream/{agent_id}", headers=headers, params=params) as response:
            if response.is_error:
                raise LiegeAPIError("Unable to open the event stream", response.status_code)
            event_id = ""
            event_type = "message"
            data: list[str] = []
            for line in response.iter_lines():
                if not line:
                    if data:
                        yield JobEvent(event_id, event_type, json.loads("\n".join(data)))
                    event_id, event_type, data = "", "message", []
                    continue
                field, _, value = line.partition(":")
                value = value.lstrip()
                if field == "id": event_id = value
                elif field == "event": event_type = value
                elif field == "data": data.append(value)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}


def _date(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def encode_x402_json(value: dict[str, Any]) -> str:
    return base64.b64encode(json.dumps(value, separators=(",", ":")).encode()).decode()


def decode_x402_payment_required(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(base64.b64decode(value).decode())
        if not isinstance(parsed, dict) or not isinstance(parsed.get("accepts"), list) or not parsed["accepts"]:
            raise ValueError("invalid challenge")
        return parsed
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError, binascii.Error) as error:
        raise LiegeAPIError("The x402 PAYMENT-REQUIRED header is invalid", 502, "x402_invalid_challenge") from error
