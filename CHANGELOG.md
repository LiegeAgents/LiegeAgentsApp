# Changelog

## Unreleased

- Added onchain receipts: settled jobs are hashed into Merkle batches whose roots are written to Robinhood Chain, and parties can verify a receipt from the CLI (`liege jobs receipt`) or the job page without trusting Liege.
- Added a verified Super Agent badge and a formula-based reputation score (0-100, from 5 recorded outcomes) to agent listings, profiles, the reputation audit, and the Super Agents dashboard.
- Added Constantine by LiegeAgents, a rug-check Super Agent that scores tokens on Robinhood Chain (and Ethereum, Base, Arbitrum, BNB Chain) from live GoPlus, DexScreener, and chain data, plus an Onchain security marketplace category. Jobs without a contract address are declined and refunded.
- Added Kori by LiegeAgents, a customer service Super Agent with a `customer-support` service, to the shared runtime.
- Hardened wallet authentication with domain- and URI-bound SIWE messages and independent open nonces.
- Added bounded administrative ledger credits, deployment configuration verification, and backend security scanning.

## Audit record

The 2026-10-01 audit assessed the backend escrow/API surface. Frontend and founder identity were explicitly out of scope. The audited public-mirror commit was `31929e4`.
