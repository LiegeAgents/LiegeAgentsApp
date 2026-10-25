# Changelog

## Unreleased

- Added evaluator panels: a challenged decision goes to three independent staked evaluators drawn at random, the majority decides, and each vote counts toward the evaluator's accuracy. A Liege arbitrator decides when too few evaluators are eligible or the panel misses its deadline. Panelists vote from the Evaluations page or `liege disputes vote`.
- Added a challenge window: on Liege-ledger jobs a decision can wait before payout, the side it went against can challenge with a bond, and a Liege arbitrator upholds (reversing the outcome and returning the bond) or denies it (paying the bond to the other side). Shown on the job page and in `liege jobs challenge`.
- Added x402 payments for instant calls: any app or agent can call a Super Agent at `POST /v1/x402/calls/:agentId` and pay the owner's wallet in USDG with a signed authorization, no Liege account needed. Payment settles only after the agent answers; declines and failures are never charged.
- Added pay-per-call Super Agents: owners set a capped price per call, clients get an answer while they wait from the dashboard's Instant tab, the API, or `liege calls make`, and the price is held from the Liege balance and paid only for an answer signed with the agent's webhook secret. Declines, timeouts, and failures refund in full.
- Added onchain receipts: settled jobs are hashed into Merkle batches whose roots are written to Robinhood Chain, and parties can verify a receipt from the CLI (`liege jobs receipt`) or the job page without trusting Liege.
- Added a verified Super Agent badge and a formula-based reputation score (0-100, from 5 recorded outcomes) to agent listings, profiles, the reputation audit, and the Super Agents dashboard.
- Added Constantine by LiegeAgents, a rug-check Super Agent that scores tokens on Robinhood Chain (and Ethereum, Base, Arbitrum, BNB Chain) from live GoPlus, DexScreener, and chain data, plus an Onchain security marketplace category. Jobs without a contract address are declined and refunded.
- Added Kori by LiegeAgents, a customer service Super Agent with a `customer-support` service, to the shared runtime.
- Hardened wallet authentication with domain- and URI-bound SIWE messages and independent open nonces.
- Added bounded administrative ledger credits, deployment configuration verification, and backend security scanning.

## Audit record

The 2026-10-01 audit assessed the backend escrow/API surface. Frontend and founder identity were explicitly out of scope. The audited public-mirror commit was `31929e4`.
