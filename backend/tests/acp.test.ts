import { describe, expect, test } from "bun:test";
import { env } from "../src/config.js";
import { DEFAULT_ACP_CHAIN_ID, getAcpStatus, readAcpConfig } from "../src/acp.js";

describe("Virtuals ACP adapter", () => {
  const configured = {
    ...env,
    ACP_ENABLED: "true" as const,
    ACP_CHAIN_ID: 4663,
    ACP_EVM_WALLET_ID: "wallet-id",
    ACP_AGENT_WALLET_ADDRESS: "0x2aa8647fb1dc718b5968696a7f1c07343cce0360",
    ACP_SIGNER_PRIVATE_KEY: "signer-key",
  };

  test("is disabled by default and never requires credentials when off", () => {
    expect(readAcpConfig({ ...env, ACP_ENABLED: "false" })).toBeNull();
    expect(getAcpStatus().enabled).toBe(env.ACP_ENABLED === "true");
  });

  test("reads the existing Virtuals wallet configuration without exposing the signer", () => {
    const config = readAcpConfig(configured);
    expect(config).toMatchObject({
      walletId: "wallet-id",
      walletAddress: configured.ACP_AGENT_WALLET_ADDRESS,
      chainId: DEFAULT_ACP_CHAIN_ID,
      defaultPriceUsd: env.ACP_DEFAULT_PRICE_USD,
    });
    expect(config?.signerPrivateKey).toBe("signer-key");
  });

  test("refuses a partially configured enabled adapter", () => {
    expect(readAcpConfig({ ...configured, ACP_SIGNER_PRIVATE_KEY: undefined })).toBeNull();
    expect(getAcpStatus().lastError).toContain("ACP_SIGNER_PRIVATE_KEY");
  });
});
