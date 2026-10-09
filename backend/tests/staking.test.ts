import { describe, expect, test } from "bun:test";
import {
  isLiegeStakeMature,
  isLiegeStakingTerm,
  liegeStakingReward,
  LIEGE_STAKING_TIERS,
} from "../src/staking.js";

describe("fixed LIEGE staking", () => {
  test("accepts only the published fixed terms", () => {
    expect([30, 45, 90].map(isLiegeStakingTerm)).toEqual([true, true, true]);
    expect(isLiegeStakingTerm(60)).toBe(false);
  });

  test("calculates locked rewards with integer base-unit arithmetic", () => {
    const principal = 1_000n * 10n ** 18n;
    expect(liegeStakingReward(principal, 30, LIEGE_STAKING_TIERS[30].apyBps)).toBe(
      4_931_506_849_315_068_493n,
    );
    expect(liegeStakingReward(principal, 45, LIEGE_STAKING_TIERS[45].apyBps)).toBe(
      11_095_890_410_958_904_109n,
    );
    expect(liegeStakingReward(principal, 90, LIEGE_STAKING_TIERS[90].apyBps)).toBe(
      34_520_547_945_205_479_452n,
    );
  });

  test("maturity uses the chain timestamp and never permits early claims", () => {
    expect(isLiegeStakeMature(2_000, 1_999)).toBe(false);
    expect(isLiegeStakeMature(2_000, 2_000)).toBe(true);
  });
});
