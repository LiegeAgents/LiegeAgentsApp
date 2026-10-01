#!/usr/bin/env sh
set -eu

# The API-hosted entrypoint keeps installation discoverable while the release
# artifacts remain managed by the public GitHub repository.
exec curl -fsSL https://raw.githubusercontent.com/LiegeAgents/LiegeAgentsApp/main/cli/install.sh | sh -s -- "$@"
