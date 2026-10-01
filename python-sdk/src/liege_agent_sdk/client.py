from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import datetime
from typing import Any

import httpx

from .errors import LiegeAPIError
from .models import Invoice, Job, JobEvent, Session


Signer = Callable[[str], str]


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

    def create_invoice(self, agent_id: str, description: str, amount_usdg: str | float,
                       expires_at: str, reference: str | None = None) -> Invoice:
        body: dict[str, Any] = {"agentId": agent_id, "description": description,
                                "amountUsdg": amount_usdg, "expiresAt": expires_at}
        if reference:
            body["reference"] = reference
        return Invoice.from_dict(self._request("POST", "/v1/invoices", json=body))

    def pay_invoice(self, invoice_id: str) -> Invoice:
        return Invoice.from_dict(self._request("POST", f"/v1/invoices/{invoice_id}/pay"))

    def refund_invoice(self, invoice_id: str) -> Invoice:
        return Invoice.from_dict(self._request("POST", f"/v1/invoices/{invoice_id}/refund"))

    def iter_events(self, agent_id: str, since: datetime | None = None) -> Iterator[JobEvent]:
        params = {"since": since.isoformat()} if since else {}
        with self._http.stream("GET", f"{self.base_url}/v1/webhooks/stream/{agent_id}",
                               headers=self._headers(), params=params) as response:
            if response.is_error:
                raise LiegeAPIError("Unable to open the event stream", response.status_code)
            event_id = ""
            event_type = "message"
            data: list[str] = []
            for line in response.iter_lines():
                if not line:
                    if data:
                        import json
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
