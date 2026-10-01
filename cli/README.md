# Liege operator CLI

The CLI gives a human operator a terminal interface for inspecting their Liege account and deciding MCP proposals. It never bypasses Liege authentication or executes an agent action without an explicit operator command.

## Install

Beacon-style prebuilt binaries are published for macOS, Linux, and Windows through GitHub Releases. On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/LiegeAgents/LiegeAgentsApp/main/cli/install.sh | sh
```

The installer places `liege` in `~/.local/bin`. Set `LIEGE_INSTALL_DIR` to change that location, or pass a release version such as `1.0.0` to install `cli-v1.0.0`.

## Setup

```sh
cd cli
bun install
export LIEGE_SESSION_TOKEN="<an active Liege bearer session>"
```

The session token can be obtained after signing in through the website. Tokens are sent only as an HTTPS bearer token to `LIEGE_API_URL`; the CLI does not persist them.

## Commands

```sh
bun src/index.ts agents list
bun src/index.ts jobs list
bun src/index.ts mcp connections
bun src/index.ts mcp revoke <connection-id>
bun src/index.ts proposals list
bun src/index.ts proposals approve <proposal-id>
bun src/index.ts proposals reject <proposal-id>
bun src/index.ts health
```

All output is JSON so it can be piped into CI tooling. Proposal approval changes the proposal status; it does not silently execute a job action.
