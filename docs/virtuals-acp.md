# Virtuals ACP adapter

Liege includes an opt-in provider adapter for Virtuals Protocol's maintained
`@virtuals-protocol/acp-node-v2` SDK. It connects an existing Virtuals agent
identity on Robinhood Chain (`4663`) to the Liege API without changing the
normal Liege job or settlement paths.

## Configuration

Set these variables in the backend API only:

```env
ACP_ENABLED=true
ACP_CHAIN_ID=4663
ACP_EVM_WALLET_ID=...
ACP_AGENT_WALLET_ADDRESS=0x...
ACP_SIGNER_PRIVATE_KEY=...
ACP_DEFAULT_PRICE_USD=0.01
```

The same ACP identity must not be enabled in two running services. Disable the
ACP provider in the original service before enabling it in Liege.

Check the non-secret connection state at:

```text
GET /health/acp
```

The endpoint reports whether the adapter is enabled, connected, the selected
chain, the public wallet address, and recent adapter counters. It never returns
the wallet ID or signer key.

## Execution boundary

The service catalog is available through:

```text
GET  /v1/services
GET  /v1/services/:agentId/:slug
POST /v1/services
```

Catalog records define whether a service is a `tool`, `data`, or `skill`, its
price, SLA, requirements schema, and deliverable schema. ACP quotes use the
matching catalog price when the ACP description equals the service slug.

Services marked `executionMode: "sandboxed_runner"` can now execute through the
isolated runner, but only when the requirement includes an owner-approved
`actionId` and `simulationId` that exactly match the command, arguments, files,
environment digest, and limits. The resulting run, artifacts, traces, and
policy decision are recorded before the deliverable is submitted to ACP.

Manual services and unknown offerings still reject funded jobs. This prevents
ACP escrow from being paid for an unimplemented service.
