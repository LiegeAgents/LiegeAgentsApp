# Liege Staking frontend

Standalone fixed-term $LIEGE staking app intended for a Vercel project rooted at this directory and the domain `staking.liegeagents.com`.

```sh
bun run build
bun run dev
```

By default, browser API requests use same-origin `/api/v1/*`; the edge function `api/[...path].js` proxies them to `https://api.liegeagents.com/v1/*` and passes the visitor's IP to the API for per-visitor rate limits. Set `LIEGE_PROXY_SECRET` on the Vercel project to the same value as the API's; without it all visitors share one rate-limit budget. Set `VITE_API_BASE_URL` only when using a different API proxy. No wallet private keys are requested or stored by this frontend. Users sign a message only when claiming a matured position.

The backend must have a funded, configured pool and `LIEGE_STAKING_ENABLED=true` before deposits are enabled. Staking principal is held by the configured pool wallet; deposits cannot be withdrawn before maturity.
