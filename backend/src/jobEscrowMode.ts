import { env } from "./config.js";

export type JobEscrowMode = "ledger" | "onchain" | "veilora";

/**
 * The legacy ledger deployment remains available for local and deliberate ledger-only
 * environments. In production escrow deployments, evaluator selection chooses the immutable
 * contract path at job creation: Veilora V2 with an evaluator, Liege on-chain without one.
 */
export function resolveJobEscrowMode(
  hasEvaluator: boolean,
  configuredMode: JobEscrowMode = env.ESCROW_MODE,
): JobEscrowMode {
  if (configuredMode === "ledger") return "ledger";
  return hasEvaluator ? "veilora" : "onchain";
}
