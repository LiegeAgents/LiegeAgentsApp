"""Hire Liege Super Agents with a hiring key over Liege's A2A endpoint."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from .client import LiegeClient
from .errors import LiegeAPIError

FINISHED = {"completed", "rejected", "canceled", "failed"}


@dataclass(frozen=True)
class HireableAgent:
    """A Super Agent that can be hired; pass ``id`` as ``agent`` to ``hire``."""

    id: str
    name: str
    description: str
    tags: list[str]


@dataclass(frozen=True)
class HireTask:
    """A hire: the proposal (also the A2A task), its job, and the delivered work."""

    id: str
    state: str
    message: str
    deliverable: str | None
    proposal_status: str | None
    job_id: str | None
    job_status: str | None

    @classmethod
    def from_task(cls, task: dict[str, Any]) -> "HireTask":
        def text(parts: list[dict[str, Any]] | None) -> str:
            return "\n".join(part.get("text", "") for part in parts or [] if part.get("kind") == "text")

        meta = task.get("metadata") or {}
        artifacts = task.get("artifacts") or []
        return cls(
            id=task["id"],
            state=task["status"]["state"],
            message=text((task["status"].get("message") or {}).get("parts")),
            deliverable=text(artifacts[0].get("parts")) if artifacts else None,
            proposal_status=meta.get("proposalStatus"),
            job_id=meta.get("jobId"),
            job_status=meta.get("jobStatus"),
        )


class LiegeHireClient:
    """Hires Liege Super Agents with a hiring key (``lmh_…``).

    Each hire is a proposal the key's owner approves and funds in Liege, within the key's USDG
    limits; this client never approves or pays.
    """

    def __init__(self, hire_key: str, base_url: str = "https://api.liegeagents.com",
                 client: httpx.Client | None = None, timeout: float = 30.0):
        if not hire_key or not hire_key.startswith("lmh_"):
            raise LiegeAPIError("A Liege hiring key (lmh_…) is required.", 401, "invalid_hire_key")
        self._client = LiegeClient(base_url, token=hire_key, client=client, timeout=timeout)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "LiegeHireClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def agents(self) -> list[HireableAgent]:
        """Super Agents that can be hired now."""
        card = self._client._request("GET", "/.well-known/agent-card.json")
        return [HireableAgent(id=s["id"], name=s["name"], description=s["description"], tags=list(s.get("tags", [])))
                for s in card["skills"]]

    def hire(self, request: str, agent: str | None = None, budget: float | None = None) -> HireTask:
        """Propose work. Name the agent with ``agent`` (an id from ``agents()``) or in the text
        ("Hire Scott to …"). Without ``budget``, the agent's listed USDG price is proposed."""
        params: dict[str, Any] = {"message": {
            "role": "user", "messageId": str(uuid.uuid4()), "parts": [{"kind": "text", "text": request}]}}
        if budget is not None:
            params["metadata"] = {"budgetAmount": budget}
        return self._rpc("message/send", params, agent)

    def task(self, task_id: str) -> HireTask:
        """The current state of a hire."""
        return self._rpc("tasks/get", {"id": task_id})

    def wait_for_result(self, task_id: str, timeout: float = 1800.0, poll: float = 10.0) -> HireTask:
        """Poll until the hire is completed, rejected, canceled, or failed. Approval and funding
        are done by a person, so allow for that in ``timeout`` (seconds, default 30 minutes)."""
        deadline = time.monotonic() + timeout
        while True:
            task = self.task(task_id)
            if task.state in FINISHED:
                return task
            if time.monotonic() >= deadline:
                raise LiegeAPIError(f"The hire is still {task.state}: {task.message}", 408, "hire_wait_timeout")
            time.sleep(poll)

    def _rpc(self, method: str, params: dict[str, Any], agent: str | None = None) -> HireTask:
        path = f"/v1/a2a/{quote(agent, safe='')}" if agent else "/v1/a2a"
        body = self._client._request("POST", path, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        error = body.get("error")
        if error:
            not_found = error.get("code") == -32001
            raise LiegeAPIError(error.get("message", "A2A request failed."), 404 if not_found else 422,
                                (error.get("data") or {}).get("code") or ("task_not_found" if not_found else "a2a_error"))
        return HireTask.from_task(body["result"])
