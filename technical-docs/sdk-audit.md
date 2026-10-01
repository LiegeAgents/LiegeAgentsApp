# Liege SDK Audit Report

**Date:** 2026-10-01  
**Scope:** Python SDK, TypeScript SDK, SDK release workflows, package contents, and SDK documentation

## Executive summary

The SDK changes were reviewed for authentication boundaries, token handling, API and MCP transport behavior, package contents, CI release controls, and test coverage. No critical security or packaging issue was found. The TypeScript hardening changes were released as `@liegeagents/agent-sdk@0.1.4` after the release workflow passed.

## Scope reviewed

- `python-sdk/`
- `typescript-sdk/`
- `.github/workflows/python-sdk.yml`
- `.github/workflows/typescript-sdk.yml`
- SDK documentation at `/docs/sdks`
- PyPI and npm published package metadata

## Security review

### Key custody

Both SDKs accept an application-provided wallet signer callback. Neither SDK receives, persists, or derives a private key. API and MCP credentials are supplied by the caller and are not written to disk by the SDK.

### Transport and authorization

The clients use HTTPS production endpoints by default, send bearer credentials only in request headers, and encode path identifiers before constructing API URLs. MCP calls use a connection-scoped token and preserve the confirmation-first proposal model.

### Private payloads

Private payload access is exposed through dedicated API methods. The SDK does not log or transform payload contents. Authorization remains enforced by the Liege API.

### Package contents

The npm dry-run package contained only the license, README, package metadata, compiled JavaScript, and declarations. No source maps, local dependencies, environment files, or credentials were included.

## Reliability review

- API errors are surfaced as typed `LiegeAPIError` values with status and optional error code.
- SSE parsing handles chunk boundaries, CRLF input, JSON data, and streams that close without a final blank separator.
- SSE readers are cancelled when iteration exits, reducing connection leaks.
- MCP initialization is performed once per client and supports empty `202` notification responses.
- npm CI uses a committed lockfile and `npm ci` for reproducible dependency installation.

## Verification evidence

- TypeScript build: passed
- TypeScript SDK tests: 5 passed
- npm audit: 0 vulnerabilities
- Frontend production build: passed
- ESLint: passed
- GitHub TypeScript release workflow: passed
- Published npm version: `@liegeagents/agent-sdk@0.1.4`
- Published Python version: `liege-agent-sdk==0.1.0`

## Residual risks and recommendations

1. Expand Python SDK coverage for authentication, event-stream reconnects, API errors, and MCP failures.
2. Add integration tests against a controlled API/MCP test environment; current tests use mocked transports.
3. Keep SDK release tags and package versions synchronized during future releases.
4. Keep connection tokens and session tokens in an application credential store, never in source control or job payloads.
5. Review dependency updates before each release even though the current npm audit is clean.

## Conclusion

The reviewed SDK implementation is suitable for the current confirmation-first API and MCP integration. It is not a wallet-key custody layer and does not independently authorize job acceptance, settlement, or execution. Those controls remain enforced by the Liege API, MCP service, and human approval workflow.
