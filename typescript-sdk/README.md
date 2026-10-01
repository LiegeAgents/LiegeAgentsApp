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
