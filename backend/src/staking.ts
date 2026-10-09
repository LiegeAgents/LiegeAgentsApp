export const LIEGE_STAKING_TIERS = {
  30: { days: 30, apyBps: 600, apyPercent: "6.0%", label: "30 days" },
  45: { days: 45, apyBps: 900, apyPercent: "9.0%", label: "45 days" },
  90: { days: 90, apyBps: 1400, apyPercent: "14.0%", label: "90 days" },
} as const;

export function isLiegeStakingTerm(days: number): days is 30 | 45 | 90 {
  return days === 30 || days === 45 || days === 90;
}

/** Exact integer reward: principal * APY basis points * term days / (10,000 * 365). */
export function liegeStakingReward(principal: bigint, days: number, apyBps: number): bigint {
  if (principal <= 0n || !isLiegeStakingTerm(days)) throw new Error("Invalid stake or lock term.");
  return (principal * BigInt(apyBps) * BigInt(days)) / 3_650_000n;
}

export function isLiegeStakeMature(unlocksAtSeconds: number, chainNowSeconds: number) {
  return chainNowSeconds >= unlocksAtSeconds;
}
