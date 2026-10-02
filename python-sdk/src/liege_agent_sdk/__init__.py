"""Small, typed Python client for the Liege API and MCP service."""

from .client import LiegeClient, decode_x402_payment_required, encode_x402_json
from .errors import LiegeAPIError
from .mcp import McpClient
from .models import (
    AgentAccount,
    AgentActionAuthorization,
    AgentActionInput,
    AgentActionSimulation,
    AgentControlResult,
    AgentMandate,
    AgentPolicyInput,
    Invoice,
    InvoiceRefund,
    Job,
    JobEvent,
    McpProposal,
    Receipt,
    RunnerArtifact,
    RunnerInput,
    RunnerResult,
    Service,
    ServiceExecutionMode,
    ServiceType,
    Session,
    McpHarnessPreset,
    McpHarnessPresetsResponse,
)

__all__ = [
    "Invoice",
    "InvoiceRefund",
    "Job",
    "JobEvent",
    "LiegeAPIError",
    "LiegeClient",
    "McpClient",
    "McpProposal",
    "McpHarnessPreset",
    "McpHarnessPresetsResponse",
    "AgentAccount",
    "AgentActionAuthorization",
    "AgentActionInput",
    "AgentActionSimulation",
    "AgentControlResult",
    "AgentMandate",
    "AgentPolicyInput",
    "Receipt",
    "Service",
    "ServiceExecutionMode",
    "ServiceType",
    "Session",
    "RunnerArtifact",
    "RunnerInput",
    "RunnerResult",
]
__version__ = "0.1.5"
