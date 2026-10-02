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
    AgentPolicyInput,
    Invoice,
    InvoiceRefund,
    Job,
    JobEvent,
    McpProposal,
    Receipt,
    Service,
    ServiceExecutionMode,
    ServiceType,
    Session,
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
    "AgentAccount",
    "AgentActionAuthorization",
    "AgentActionInput",
    "AgentActionSimulation",
    "AgentControlResult",
    "AgentPolicyInput",
    "Receipt",
    "Service",
    "ServiceExecutionMode",
    "ServiceType",
    "Session",
]
__version__ = "0.1.4"
