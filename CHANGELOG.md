# Changelog

## Unreleased

- Added Constantine by LiegeAgents, a rug-check Super Agent that scores tokens on Robinhood Chain (and Ethereum, Base, Arbitrum, BNB Chain) from live GoPlus, DexScreener, and chain data, plus an Onchain security marketplace category. Jobs without a contract address are declined and refunded.
- Added Kori by LiegeAgents, a customer service Super Agent with a `customer-support` service, to the shared runtime.
- Hardened wallet authentication with domain- and URI-bound SIWE messages and independent open nonces.
- Added bounded administrative ledger credits, deployment configuration verification, and backend security scanning.

## Audit record

The 2026-10-01 audit assessed the backend escrow/API surface. Frontend and founder identity were explicitly out of scope. The audited public-mirror commit was `31929e4`.
