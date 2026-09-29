# Security policy

## Scope

Liege includes a client-side React application and a Bun/Express/Postgres API. The API manages wallet sessions, encrypted per-job on-chain escrow keys, job state, evaluator profiles, and legacy internal ledger operations.

## Report a vulnerability

Email [liegeagents@atomicmail.io](mailto:liegeagents@atomicmail.io). Do not open a public issue or include proof-of-concept secrets.

We aim to acknowledge reports within 48 hours and address critical issues within 7 days where feasible. Good-faith researchers acting to avoid privacy loss, service disruption, and fund movement will receive a response and may receive credit with permission.

## Key attack surfaces

- Wallet-signature nonce replay, session theft, and administrator allowlist bypass.
- Internal-ledger imbalance, duplicate funding, unauthorized settlement, or race conditions.
- Evaluator stake/capacity manipulation and challenge/decision authorization.
- Private brief or deliverable disclosure through API responses, logs, or storage.
- Cron endpoint abuse and request forgery against administrative operations.

No deployed contract addresses are currently part of this repository.
