from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class Session:
    token: str
    expires_at: datetime | None
    user_id: str
    wallet_address: str


@dataclass(frozen=True)
class Job:
    id: str
    status: str
    title: str
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Job":
        return cls(value["id"], value["status"], value["title"], value)


@dataclass(frozen=True)
class McpProposal:
    id: str
    status: str
    expires_at: datetime | None
    raw: dict[str, Any]


@dataclass(frozen=True)
class JobEvent:
    id: str
    event_type: str
    data: dict[str, Any]
