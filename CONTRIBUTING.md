# Contributing to Liege

## Current priorities

Contributions are welcome for the API’s job lifecycle, internal-ledger correctness, wallet-auth hardening, API tests, client/API integration, and operational documentation.

## Out of scope

Do not submit deployed trading, custody, payment, or smart-contract functionality without an approved issue and security review. Do not add private keys, real credentials, sensitive job content, or claims of investment performance.

## Setup

1. Fork and clone the repository.
2. Install frontend dependencies with `bun install`.
3. For backend work, copy `backend/.env.example` to `backend/.env`, set local non-production values, then run `cd backend && bun install`.
4. Run `bun run check` and `bun test` inside `backend` before opening a pull request.

## Workflow

Create a focused branch from `main`, make one concern-sized change, add or update meaningful tests, and open a pull request describing behavior, risks, and verification. Discuss cross-cutting architecture, financial flows, schema changes, and external integrations in an issue before implementation.

## Commit style

Use short imperative present-tense messages, for example: `add evaluator capacity check`.

## Reporting bugs

Include the feature/job flow involved, actual and expected behavior, reproduction steps, relevant request/response details with secrets removed, and your runtime/version information.

Report vulnerabilities privately under [SECURITY.md](SECURITY.md), not in a public issue.
