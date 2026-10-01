import type {
  AcpAgent as AcpAgentType,
  JobRoomEntry,
  JobSession,
} from "@virtuals-protocol/acp-node-v2";
import type { Address } from "viem";
import { env } from "./config.js";
import { db } from "./db/index.js";
import { executeAcpRunner } from "./acpRunner.js";

export const DEFAULT_ACP_CHAIN_ID = 4663;

export type AcpProviderConfig = {
  walletId: string;
  walletAddress: Address;
  signerPrivateKey: string;
  builderCode?: string;
  chainId: number;
  defaultPriceUsd: number;
};

export type AcpProviderStatus = {
  enabled: boolean;
  connected: boolean;
  chainId: number | null;
  walletAddress: string | null;
  startedAt: string | null;
  lastError: string | null;
  jobsObserved: number;
  jobsRejected: number;
};

const status: AcpProviderStatus = {
  enabled: env.ACP_ENABLED === "true",
  connected: false,
  chainId: null,
  walletAddress: null,
  startedAt: null,
  lastError: null,
  jobsObserved: 0,
  jobsRejected: 0,
};

let agent: AcpAgentType | null = null;

export function readAcpConfig(source: typeof env = env): AcpProviderConfig | null {
  if (source.ACP_ENABLED !== "true") return null;
  const missing = [
    !source.ACP_EVM_WALLET_ID && "ACP_EVM_WALLET_ID",
    !source.ACP_AGENT_WALLET_ADDRESS && "ACP_AGENT_WALLET_ADDRESS",
    !source.ACP_SIGNER_PRIVATE_KEY && "ACP_SIGNER_PRIVATE_KEY",
  ].filter(Boolean) as string[];
  if (missing.length) {
    status.lastError = `missing ${missing.join(", ")}`;
    return null;
  }
  return {
    walletId: source.ACP_EVM_WALLET_ID!,
    walletAddress: source.ACP_AGENT_WALLET_ADDRESS! as Address,
    signerPrivateKey: source.ACP_SIGNER_PRIVATE_KEY!,
    builderCode: source.ACP_BUILDER_CODE,
    chainId: source.ACP_CHAIN_ID || DEFAULT_ACP_CHAIN_ID,
    defaultPriceUsd: source.ACP_DEFAULT_PRICE_USD,
  };
}

export function getAcpStatus(): AcpProviderStatus {
  return { ...status };
}

function requirement(session: JobSession): unknown | null {
  for (let index = session.entries.length - 1; index >= 0; index--) {
    const entry = session.entries[index];
    if (entry.kind !== "message" || entry.contentType !== "requirement") continue;
    try {
      return JSON.parse(entry.content);
    } catch {
      return entry.content;
    }
  }
  return null;
}

async function catalogService(session: JobSession, walletAddress: string) {
  const job = session.job ?? (await session.fetchJob());
  const result = await db.query<{
    price_usd: string;
    execution_mode: "manual" | "sandboxed_runner";
    agent_id: string;
    owner_id: string;
  }>(
    `SELECT s.price_usd, s.execution_mode, a.id AS agent_id, a.owner_id
     FROM commerce_services s
     JOIN agents a ON a.id = s.agent_id
     JOIN users u ON u.id = a.owner_id
     WHERE lower(u.wallet_address) = lower($1) AND s.slug = $2 AND s.active AND a.active`,
    [walletAddress, job.description.trim()],
  );
  return result.rows[0] ?? null;
}

/**
 * ACP is deliberately confirmation-safe here: Liege only executes catalog
 * services whose handler and owner-approved simulation are both present.
 * Unknown or manual services are rejected instead of being paid for blindly.
 */
export async function handleAcpEntry(
  session: JobSession,
  entry: JobRoomEntry,
  config: Pick<AcpProviderConfig, "defaultPriceUsd" | "walletAddress">,
): Promise<void> {
  if (!session.roles.includes("provider") || entry.kind !== "system") return;
  if (!session.shouldRespond(entry)) return;

  if (entry.event.type === "job.created") {
    const { AssetToken } = await import("@virtuals-protocol/acp-node-v2");
    const service = await catalogService(session, config.walletAddress);
    await session.setBudget(
      AssetToken.usdc(
        service ? Number(service.price_usd) : config.defaultPriceUsd,
        session.chainId,
      ),
    );
    status.jobsObserved++;
    return;
  }

  if (entry.event.type !== "job.funded") return;
  const service = await catalogService(session, config.walletAddress);
  const value = requirement(session);
  if (service?.execution_mode === "sandboxed_runner" && value !== null) {
    const result = await executeAcpRunner(service.agent_id, service.owner_id, value);
    await session.submit(JSON.stringify(result));
    return;
  }
  status.jobsRejected++;
  await session.reject(
    value === null
      ? "Liege ACP adapter received no requirement payload."
      : service
        ? "This Liege ACP service requires a supported execution handler."
        : "No active Liege service matches this ACP offering.",
  );
}

export async function startAcpProvider(): Promise<AcpAgentType | null> {
  const config = readAcpConfig();
  status.enabled = env.ACP_ENABLED === "true";
  if (!config) {
    if (!status.enabled) status.lastError = null;
    console.log("[acp] Provider disabled or incomplete; no ACP connection started.");
    return null;
  }

  status.chainId = config.chainId;
  status.walletAddress = config.walletAddress;
  try {
    const { AcpAgent, PrivyAlchemyEvmProviderAdapter, getEvmChainByChainId } =
      await import("@virtuals-protocol/acp-node-v2");
    const chain = getEvmChainByChainId(config.chainId);
    if (!chain) throw new Error(`chain ${config.chainId} is not supported by the ACP SDK`);
    const evmProvider = await PrivyAlchemyEvmProviderAdapter.create({
      chains: [chain],
      walletId: config.walletId,
      walletAddress: config.walletAddress,
      signerPrivateKey: config.signerPrivateKey,
      builderCode: config.builderCode,
    });
    agent = await AcpAgent.create({ evmProvider });
    agent.on("entry", (session, entry) =>
      handleAcpEntry(session, entry, config).catch((error) => {
        status.lastError = String(error instanceof Error ? error.message : error).slice(0, 200);
        console.error("[acp] entry handler failed:", error);
      }),
    );
    await agent.start(() => {
      status.connected = true;
      status.startedAt = new Date().toISOString();
      status.lastError = null;
      console.log(`[acp] Provider connected on chain ${config.chainId}.`);
    });
    return agent;
  } catch (error) {
    status.connected = false;
    status.lastError = String(error instanceof Error ? error.message : error).slice(0, 200);
    console.error("[acp] Provider failed to start:", error);
    return null;
  }
}

export async function stopAcpProvider() {
  if (!agent) return;
  await agent.stop();
  agent = null;
  status.connected = false;
}
