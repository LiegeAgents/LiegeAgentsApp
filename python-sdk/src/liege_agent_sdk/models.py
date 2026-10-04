from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, TypedDict


def _date(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))

ServiceType = Literal["tool", "data", "skill"]
ServiceExecutionMode = Literal["manual", "sandboxed_runner"]
ApprovalMode = Literal["always", "within_policy"]

@dataclass(frozen=True)
class Page:
    """A typed page returned by a cursor-aware Liege list endpoint."""
    items: list[Any]
    next_cursor: str | None = None
    total: int | None = None


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

RunnerCommand = Literal["node", "bun", "python", "python3"]
WebhookEventType = Literal["job.funded", "job.submitted", "job.completed", "job.rejected", "job.expired", "job.settled", "invoice.created", "invoice.paid", "invoice.refunded", "invoice.partially_refunded", "invoice.cancelled", "invoice.expired"]

class WebhookCreateInput(TypedDict, total=False):
    agentId: str
    url: str
    eventTypes: list[WebhookEventType]

class RunnerInput(TypedDict, total=False):
    agentId: str
    jobId: str
    command: RunnerCommand
    args: list[str]
    env: dict[str, str]
    files: dict[str, str]
    artifactPaths: list[str]
    timeoutMs: int
    maxOutputBytes: int
    actionId: str
    simulationId: str


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
class McpExecutionGrant:
    grant_token: str
    job_id: str
    expires_at: datetime | None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "McpExecutionGrant":
        return cls(
            str(value.get("grantToken", value.get("grant_token", ""))),
            str(value.get("jobId", value.get("job_id", ""))),
            _date(value.get("expiresAt", value.get("expires_at"))),
        )


@dataclass(frozen=True)
class McpEvent:
    id: str
    cursor: str
    event_type: str
    payload: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "McpEvent":
        return cls(
            str(value["id"]),
            str(value["cursor"]),
            str(value.get("eventType", value.get("event_type", ""))),
            dict(value.get("payload") or {}),
        )


@dataclass(frozen=True)
class McpEventPage:
    items: list[McpEvent]
    next_cursor: str | None = None


@dataclass(frozen=True)
class McpEventWait:
    event: McpEvent | None
    timed_out: bool
    cursor: str | None = None


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
class AgentReputationAudit:
    agent: dict[str, Any]
    settlement: dict[str, Any]
    jobs: dict[str, Any]
    sla: dict[str, Any]
    disputes: dict[str, Any]
    catalog: dict[str, Any]
    mandates: dict[str, Any]
    audit_digest: str
    audited_at: str
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentReputationAudit":
        return cls(
            value.get("agent", {}), value.get("settlement", {}), value.get("jobs", {}),
            value.get("sla", {}), value.get("disputes", {}), value.get("catalog", {}),
            value.get("mandates", {}), str(value.get("auditDigest", value.get("audit_digest", ""))),
            str(value.get("auditedAt", value.get("audited_at", ""))), value,
        )


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

@dataclass(frozen=True)
class RunnerArtifact:
    name: str
    sha256: str
    id: str | None = None
    size_bytes: int | None = None
    created_at: str | None = None
    content_base64: str | None = None
    raw: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "RunnerArtifact":
        return cls(str(value.get("name", "")), str(value.get("sha256", "")), value.get("id"), value.get("sizeBytes", value.get("size_bytes")), value.get("createdAt", value.get("created_at")), value.get("contentBase64", value.get("content_base64")), value)

@dataclass(frozen=True)
class RunnerResult:
    id: str
    status: str
    artifacts: list[RunnerArtifact]
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "RunnerResult":
        return cls(str(value["id"]), str(value.get("status", "")), [RunnerArtifact.from_dict(item) for item in value.get("artifacts", [])], value)

@dataclass(frozen=True)
class WebhookSubscription:
    id: str
    agent_id: str
    url: str
    event_types: list[str]
    active: bool
    secret: str | None
    raw: dict[str, Any]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "WebhookSubscription":
        return cls(str(value["id"]), str(value.get("agentId", value.get("agent_id", ""))), str(value["url"]), list(value.get("eventTypes", value.get("event_types", []))), bool(value.get("active", False)), value.get("secret"), value)


@dataclass(frozen=True)
class Receipt:
    receipt_id: str
    type: str
    reference: str
    created_at: str
    asset: str | None = None
    available_change: str | None = None
    stake_change: str | None = None
    subject: dict[str, Any] | None = None
    raw: dict[str, Any] = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "Receipt":
        return cls(
            receipt_id=value.get("receiptId", value.get("receipt_id", "")),
            type=value.get("type", ""),
            reference=value.get("reference", ""),
            created_at=value.get("createdAt", value.get("created_at", "")),
            asset=value.get("asset"),
            available_change=value.get("availableChange"),
            stake_change=value.get("stakeChange"),
            subject=value.get("subject"),
            raw=value,
        )


@dataclass(frozen=True)
class AgentMandate:
    id: str
    agent_id: str
    nonce: str
    digest: str
    payload: dict[str, Any]
    signature: str
    status: str
    expires_at: str
    created_at: str
    parent_mandate_id: str | None = None
    revoked_at: str | None = None
    raw: dict[str, Any] = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentMandate":
        return cls(
            id=value.get("id", ""),
            agent_id=value.get("agent_id", value.get("agentId", "")),
            nonce=value.get("nonce", ""),
            digest=value.get("digest", ""),
            payload=value.get("payload", {}),
            signature=value.get("signature", ""),
            status=value.get("status", "active"),
            expires_at=str(value.get("expires_at", value.get("expiresAt", ""))),
            created_at=str(value.get("created_at", value.get("createdAt", ""))),
            parent_mandate_id=value.get("parent_mandate_id", value.get("parentMandateId")),
            revoked_at=value.get("revoked_at", value.get("revokedAt")),
            raw=value,
        )


@dataclass(frozen=True)
class McpHarnessPreset:
    id: str
    name: str
    target: str
    filename: str
    description: str
    instructions: str
    format: str
    config: dict[str, Any]
    raw: dict[str, Any] = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "McpHarnessPreset":
        return cls(
            id=value.get("id", ""),
            name=value.get("name", ""),
            target=value.get("target", value.get("id", "")),
            filename=value.get("filename", ""),
            description=value.get("description", ""),
            instructions=value.get("instructions", ""),
            format=value.get("format", "json"),
            config=value.get("config", {}),
            raw=value,
        )


@dataclass(frozen=True)
class McpHarnessPresetsResponse:
    server_url: str
    presets: dict[str, McpHarnessPreset]
    connection_id: str | None = None
    agent_id: str | None = None
    agent_name: str | None = None
    connection_name: str | None = None
    raw: dict[str, Any] = None

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "McpHarnessPresetsResponse":
        raw_presets = value.get("presets", {})
        presets = {k: McpHarnessPreset.from_dict(v) for k, v in raw_presets.items()}
        return cls(
            server_url=value.get("serverUrl", value.get("server_url", "")),
            presets=presets,
            connection_id=value.get("connectionId", value.get("connection_id")),
            agent_id=value.get("agentId", value.get("agent_id")),
            agent_name=value.get("agentName", value.get("agent_name")),
            connection_name=value.get("connectionName", value.get("connection_name")),
            raw=value,
        )
