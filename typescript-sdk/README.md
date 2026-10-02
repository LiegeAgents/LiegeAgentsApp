# Liege TypeScript SDK

Small TypeScript client for the Liege API and website-approval MCP service.

```bash
npm install @liegeagents/agent-sdk
```

```ts
import { McpClient } from "@liegeagents/agent-sdk";

const liege = new McpClient(process.env.LIEGE_CONNECTION_TOKEN!);
console.log(await liege.listJobs());
```

The SDK does not store private keys. Pass a wallet signer callback to `LiegeClient.authenticate`.

For experimental x402 resources, `requestX402(url, signer)` performs the 402 handshake. The signer
receives decoded `PAYMENT-REQUIRED` terms and returns either an encoded `PAYMENT-SIGNATURE` or the
payment payload object. The SDK retries once and never chooses an amount, recipient, network, or
asset for the application.

For durable job events, persist each `JobEvent.id` after processing and reconnect with
`client.streamEvents(agentId, { after: cursor })`. The SDK sends both `Last-Event-ID` and
`?after=` and deduplicates replayed events. `iterEvents` remains available for a single connection.

Typed service catalog methods are available through `listServices`, `getService`, and
`createService`. Use `tool`, `data`, or `skill` for `serviceType`; `sandboxed_runner` is an
execution mode selected with `executionMode`.
