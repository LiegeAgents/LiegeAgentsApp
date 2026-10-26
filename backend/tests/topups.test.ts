import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  TransactionReceiptNotFoundError,
} from "viem";
import {
  api,
  availableBalance,
  bearer,
  clearData,
  databaseAvailable,
  rebuildSchema,
  signIn,
  type User,
} from "./support.js";
import { env } from "../src/config.js";
import { topupChain } from "../src/topups.js";

const transfer = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const usdg = "0x" + "5d".repeat(20);
const treasury = `0x${"7e".repeat(20)}` as const;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

const log = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: encodeEventTopics({
    abi: [transfer],
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  }) as [`0x${string}`, ...`0x${string}`[]],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});

describe.skipIf(!databaseAvailable)("workspace top-ups", () => {
  beforeAll(rebuildSchema);
  const original = { address: env.TOPUP_ADDRESS, usdg: env.USDG_TOKEN_ADDRESS };
  const spies: Array<{ mockRestore(): void }> = [];
  let user: User;
  beforeEach(async () => {
    await clearData();
    user = await signIn();
    env.TOPUP_ADDRESS = treasury;
    env.USDG_TOKEN_ADDRESS = usdg;
  });
  afterEach(() => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
    env.TOPUP_ADDRESS = original.address;
    env.USDG_TOKEN_ADDRESS = original.usdg;
  });

  /** A chain where each hash has the given receipt, at the given head block. */
  function chain(
    receipts: Record<string, { status?: string; block?: bigint; logs: object[] }>,
    head = 110n,
  ) {
    spies.push(
      spyOn(topupChain, "receipt").mockImplementation(async (h) => {
        const r = receipts[h];
        if (!r) throw new TransactionReceiptNotFoundError({ hash: h });
        return {
          status: (r.status ?? "success") as "success",
          blockNumber: r.block ?? 100n,
          logs: r.logs as never,
        };
      }),
      spyOn(topupChain, "head").mockImplementation(async () => head),
    );
  }

  const claim = (txHash: string, asset = "usdg", who = user) =>
    api().post("/v1/me/topups").set(bearer(who)).send({ txHash, asset });

  test("a transfer from your wallet to the top-up address is credited once", async () => {
    chain({
      [hash(1)]: {
        logs: [
          log(usdg, user.address, treasury, 25_500_000n),
          // Someone else's transfer in the same transaction does not count.
          log(usdg, "0x" + "11".repeat(20), treasury, 9_000_000n),
        ],
      },
    });
    const info = (await api().get("/v1/me/topups").set(bearer(user)).expect(200)).body.data;
    expect(info).toMatchObject({ enabled: true, address: treasury, confirmations: 2 });
    expect(info.tokens.usdg).toEqual({ address: usdg, decimals: 6 });

    const credited = (await claim(hash(1)).expect(201)).body.data;
    expect(credited).toMatchObject({ amount: "25.5", asset: "usdg", alreadyCredited: false });
    expect(await availableBalance(user.userId)).toBe(25.5);
    // Claiming again changes nothing; another account cannot take it.
    expect((await claim(hash(1)).expect(200)).body.data.alreadyCredited).toBe(true);
    expect(await availableBalance(user.userId)).toBe(25.5);
    const other = await signIn();
    expect((await claim(hash(1), "usdg", other).expect(409)).body.error.code).toBe(
      "topup_already_used",
    );
    const history = (await api().get("/v1/me/topups").set(bearer(user)).expect(200)).body.data
      .topups;
    expect(history).toHaveLength(1);
  });

  test("waits for indexing and confirmations, and refuses failed or unrelated transfers", async () => {
    chain(
      {
        [hash(2)]: { block: 110n, logs: [log(usdg, user.address, treasury, 1_000_000n)] },
        [hash(3)]: { status: "reverted", logs: [] },
        [hash(4)]: { logs: [log(usdg, user.address, "0x" + "22".repeat(20), 1_000_000n)] },
        [hash(5)]: { logs: [log("0x" + "33".repeat(20), user.address, treasury, 1_000_000n)] },
      },
      110n,
    );
    expect((await claim(hash(9)).expect(202)).body.error.code).toBe("awaiting_receipt");
    expect((await claim(hash(2)).expect(202)).body.error.code).toBe("awaiting_confirmations");
    expect((await claim(hash(3)).expect(422)).body.error.code).toBe("topup_failed");
    // Sent somewhere else, or a different token.
    expect((await claim(hash(4)).expect(422)).body.error.code).toBe("topup_not_found");
    expect((await claim(hash(5)).expect(422)).body.error.code).toBe("topup_not_found");
    // LIEGE transfers are only counted as LIEGE.
    expect((await claim(hash(2), "liege").expect(202)).body.error.code).toBe(
      "awaiting_confirmations",
    );
    expect(await availableBalance(user.userId)).toBe(0);
  });

  test("is off without a top-up address", async () => {
    env.TOPUP_ADDRESS = undefined;
    expect((await claim(hash(1)).expect(503)).body.error.code).toBe("topups_unavailable");
    const info = (await api().get("/v1/me/topups").set(bearer(user)).expect(200)).body.data;
    expect(info).toMatchObject({ enabled: false, address: null });
  });

  test("credits LIEGE at 18 decimals", async () => {
    chain({
      [hash(6)]: {
        logs: [log(env.LIEGE_TOKEN_ADDRESS, user.address, treasury, 1_500n * 10n ** 18n)],
      },
    });
    expect((await claim(hash(6), "liege").expect(201)).body.data.amount).toBe("1500");
  });
});
