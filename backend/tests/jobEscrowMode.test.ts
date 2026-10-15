import { describe, expect, test } from "bun:test";
import { resolveJobEscrowMode } from "../src/jobEscrowMode.js";
import { factoryVersion } from "../src/veiloraEscrow.js";

describe("per-job escrow routing", () => {
  test("uses Veilora V2 when an independent evaluator is selected", () => {
    expect(resolveJobEscrowMode(true, "veilora")).toBe("veilora");
    expect(resolveJobEscrowMode(true, "onchain")).toBe("veilora");
  });

  test("uses Liege on-chain escrow for client-evaluated jobs", () => {
    expect(resolveJobEscrowMode(false, "veilora")).toBe("onchain");
    expect(resolveJobEscrowMode(false, "onchain")).toBe("onchain");
  });

  test("keeps an explicitly configured ledger-only environment on the ledger", () => {
    expect(resolveJobEscrowMode(true, "ledger")).toBe("ledger");
    expect(resolveJobEscrowMode(false, "ledger")).toBe("ledger");
  });

  test("preserves the factory version stored on existing Veilora job terms", () => {
    expect(factoryVersion({ factoryVersion: 1 })).toBe(1);
    expect(factoryVersion({ factoryVersion: 2 })).toBe(2);
  });
});
