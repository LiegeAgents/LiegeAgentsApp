# Liege Staking frontend

Standalone fixed-term $LIEGE staking app intended for a Vercel project rooted at this directory and the domain `staking.liegeagents.com`.

```sh
bun run build
bun run dev
```

By default, browser API requests use same-origin `/api/v1/*`; `vercel.json` proxies those paths to `https://api.liegeagents.com/v1/*`. Set `VITE_API_BASE_URL` only when using a different API proxy. No wallet private keys are requested or stored by this frontend. Users sign a message only when claiming a matured position.

The backend must have a funded, configured pool and `LIEGE_STAKING_ENABLED=true` before deposits are enabled. Staking principal is held by the configured pool wallet; deposits cannot be withdrawn before maturity.
