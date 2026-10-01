"""Small, typed Python client for the Liege API and MCP service."""

from .client import LiegeClient
from .errors import LiegeAPIError
from .mcp import McpClient
from .models import Invoice, Job, JobEvent, McpProposal, Session

__all__ = ["Invoice", "Job", "JobEvent", "LiegeAPIError", "LiegeClient", "McpClient", "McpProposal", "Session"]
__version__ = "0.1.0"
