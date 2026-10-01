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
