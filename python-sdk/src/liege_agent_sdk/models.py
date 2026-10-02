from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, TypedDict

ServiceType = Literal["tool", "data", "skill"]
ServiceExecutionMode = Literal["manual", "sandboxed_runner"]
ApprovalMode = Literal["always", "within_policy"]


class AgentPolicyInput(TypedDict, total=False):
    maxActionAmount: float | str | None
    dailyBudget: float | str | None
    monthlyBudget: float | str | None
    allowedAssets: list[str]
    allowedVenues: list[str]
    approvedCounterparties: list[str]
    allowedActions: list[str]
    approvalMode: ApprovalMode
    simulationRequired: bool
    requireHumanAbove: float | str | None
    activeHours: dict[str, int] | None
    activeDays: list[int]
    timezone: str


class AgentActionInput(TypedDict, total=False):
    action: str
    amount: float | str
    asset: str
    venue: str
    counterparty: str
    details: dict[str, Any]
    simulationId: str
    simulationDigest: str
    simulate: bool


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


@dataclass(frozen=True)
class AgentPolicy:
    version: int
    max_action_amount: str | None
    daily_budget: str | None
    monthly_budget: str | None
    allowed_assets: list[str]
    allowed_venues: list[str]
    approved_counterparties: list[str]
    allowed_actions: list[str]
    approval_mode: ApprovalMode
    simulation_required: bool
    require_human_above: str | None
    active_hours: dict[str, int] | None
    active_days: list[int]
    timezone: str


@dataclass(frozen=True)
class AgentAccount:
    account_id: str
    agent_id: str
    status: str
    kill_reason: str | None
    paused_at: str | None
    policy: AgentPolicy | None
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentAccount":
        policy = value.get("policy")
        parsed_policy = None
        if policy:
            parsed_policy = AgentPolicy(
                int(policy["version"]), policy.get("maxActionAmount"), policy.get("dailyBudget"),
                policy.get("monthlyBudget"), policy.get("allowedAssets", []), policy.get("allowedVenues", []),
                policy.get("approvedCounterparties", []), policy.get("allowedActions", []),
                policy.get("approvalMode", "always"), bool(policy.get("simulationRequired", True)),
                policy.get("requireHumanAbove"), policy.get("activeHours"), policy.get("activeDays", []),
                policy.get("timezone", "UTC"),
            )
        return cls(value.get("accountId", value.get("agentId")), value["agentId"], value["status"],
                   value.get("killReason"), value.get("pausedAt"), parsed_policy, value)


@dataclass(frozen=True)
class AgentActionSimulation:
    id: str
    action_digest: str
    action: dict[str, Any]
    result: dict[str, Any]
    policy_version: int
    expires_at: str
    created_at: str
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentActionSimulation":
        return cls(value["id"], value.get("action_digest", value.get("actionDigest", "")), value.get("action", {}),
                   value.get("result", {}), int(value.get("policy_version", value.get("policyVersion", 0))),
                   str(value.get("expires_at", value.get("expiresAt", ""))), str(value.get("created_at", value.get("createdAt", ""))), value)


@dataclass(frozen=True)
class AgentActionAuthorization:
    action_id: str
    account_id: str
    decision: str
    reasons: list[str]
    policy_version: int
    simulation_digest: str | None
    created_at: str
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentActionAuthorization":
        return cls(value.get("actionId", value.get("id", "")), value.get("accountId", value.get("agentId", "")),
                   value["decision"], value.get("reasons", []), int(value.get("policyVersion", value.get("policy_version", 0))),
                   value.get("simulationDigest", value.get("simulation_digest")), str(value.get("createdAt", value.get("created_at", ""))), value)


@dataclass(frozen=True)
class AgentControlResult:
    account_id: str
    status: str
    kill_reason: str | None
    revoked_connections: int
    rejected_proposals: int
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentControlResult":
        return cls(value.get("accountId", value.get("agentId", "")), value["status"], value.get("killReason"),
                   int(value.get("revokedConnections", 0)), int(value.get("rejectedProposals", 0)), value)
