from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

ServiceType = Literal["tool", "data", "skill"]
ServiceExecutionMode = Literal["manual", "sandboxed_runner"]


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


@dataclass(frozen=True)
class InvoiceRefund:
    id: str
    invoice_id: str
    payer_id: str
    issuer_id: str
    amount: float
    amount_usdg: float
    asset: str
    job_id: str | None
    reason: str | None
    refunded_at: str
    ledger_transaction_id: str
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "InvoiceRefund":
        amount_usdg = float(value.get("amountUsdg") or value.get("amount", 0))
        amount = float(value.get("amount") or amount_usdg)
        return cls(
            value["id"],
            value.get("invoiceId", value.get("invoice_id", "")),
            value.get("payerId", value.get("payer_id", "")),
            value.get("issuerId", value.get("issuer_id", "")),
            amount,
            amount_usdg,
            str(value.get("asset", "usdg")),
            value.get("jobId", value.get("job_id")),
            value.get("reason"),
            str(value.get("refundedAt", value.get("refunded_at", ""))),
            str(value.get("ledgerTransactionId", value.get("ledger_transaction_id", ""))),
            value,
        )


@dataclass(frozen=True)
class Invoice:
    id: str
    public_id: str
    amount_usdg: float
    status: str
    amount: float | None = None
    asset: str = "usdg"
    refunded_amount: float = 0.0
    refunded_amount_usdg: float = 0.0
    remaining_amount: float | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Invoice":
        amount_usdg = float(value.get("amountUsdg") or value.get("amount", 0))
        amount = float(value.get("amount") or amount_usdg)
        asset = str(value.get("asset", "usdg"))
        refunded_amount_usdg = float(value.get("refundedAmountUsdg") or value.get("refunded_amount_usdg") or 0)
        refunded_amount = float(value.get("refundedAmount") or value.get("refunded_amount") or refunded_amount_usdg)
        remaining_amount_raw = value.get("remainingAmount") or value.get("remaining_amount")
        remaining_amount = float(remaining_amount_raw) if remaining_amount_raw is not None else max(0.0, amount - refunded_amount)
        return cls(
            value["id"],
            value.get("publicId", value["id"]),
            amount_usdg,
            value["status"],
            amount,
            asset,
            refunded_amount,
            refunded_amount_usdg,
            remaining_amount,
        )


@dataclass(frozen=True)
class Service:
    id: str
    agent_id: str
    slug: str
    name: str
    description: str
    service_type: ServiceType
    execution_mode: ServiceExecutionMode
    price_usd: float
    sla_minutes: int
    requirements_schema: dict[str, Any]
    deliverable_schema: dict[str, Any]
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Service":
        return cls(
            value["id"], value.get("agent_id", value.get("agentId")), value["slug"],
            value["name"], value["description"], value.get("service_type", value.get("serviceType")),
            value.get("execution_mode", value.get("executionMode", "manual")),
            float(value.get("price_usd", value.get("priceUsd"))), int(value["sla_minutes"] if "sla_minutes" in value else value["slaMinutes"]),
            value.get("requirements_schema", value.get("requirementsSchema", {})),
            value.get("deliverable_schema", value.get("deliverableSchema", {})), value,
        )
