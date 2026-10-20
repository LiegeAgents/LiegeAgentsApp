import { describe, expect, test } from "bun:test";

for (const key of ["SCOTT", "ANNA", "MARCUS", "CHLOE", "DANIEL"]) {
  process.env[`${key}_AGENT_ID`] = `${key.toLowerCase()}-agent`;
  process.env[`${key}_WEBHOOK_SECRET`] = `${key.toLowerCase()}-secret`;
}
process.env.LIEGE_API_URL = "https://api.example.com";
process.env.LIEGE_RUNTIME_TOKEN = "runtime-token";
process.env.GROQ_API_KEY = "groq-key";

const {
  assess,
  chains,
  constantineSystemPrompt,
  createConstantineHandler,
  findToken,
  readToken,
  watchSnapshot,
} = await import("./constantine.js");

const token = "0xc32ab2e562ade6fba6d3d1e3960d49b0957ef645";
const now = Date.parse("2026-10-15T12:00:00Z");

// A healthy token: verified, renounced, spread out, deep liquidity.
const clean = {
  token_name: "Liege Agents",
  token_symbol: "LIEGE",
  is_honeypot: "0",
  is_open_source: "1",
  is_mintable: "0",
  hidden_owner: "0",
  owner_address: "0x0000000000000000000000000000000000000000",
  buy_tax: "0",
  sell_tax: "0",
  creator_percent: "0.000000",
  holder_count: "709",
  holders: [
    { address: "0x000000000000000000000000000000000000dEaD", percent: "0.12", is_locked: 1 },
    { address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", percent: "0.10", is_contract: 1 },
    { address: "0x1111111111111111111111111111111111111111", percent: "0.04" },
    { address: "0x2222222222222222222222222222222222222222", percent: "0.03" },
  ],
  dex: [{ pair: "0xpool", pool_manager: "0x8366a39cc670b4001a1121b8f6a443a643e40951" }],
};
const pair = {
  chainId: "robinhood",
  url: "https://dexscreener.com/robinhood/0xpool",
  pairAddress: "0xpool",
  baseToken: { address: token, name: "Liege Agents", symbol: "LIEGE" },
  priceUsd: "0.00025",
  liquidity: { usd: 45_000 },
  volume: { h24: 56_000 },
  txns: { h24: { buys: 203, sells: 193 } },
  fdv: 220_000,
  pairCreatedAt: now - 30 * 86_400_000,
};

/** A fake network: GoPlus, DexScreener, and the Robinhood Chain RPC, recording each call. */
function network(security: unknown, pairs: unknown[] = [pair], code = "0x6080") {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    const body = url.includes("gopluslabs")
      ? { code: 1, result: security ? { [token]: security } : {} }
      : url.includes("dexscreener")
        ? { pairs }
        : { jsonrpc: "2.0", id: 1, result: code };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  return { calls, fetcher };
}

const facts = (security: unknown, pairs: unknown[] = [pair]) => ({
  address: token,
  chain: chains.robinhood,
  security: security as never,
  pairs: pairs as never,
  isContract: true,
  checkedAt: new Date(now).toISOString(),
});

describe("Constantine rug checks", () => {
  test("finds the token and its chain, defaulting to Robinhood Chain", () => {
    expect(findToken(`Is ${token.toUpperCase().replace("0X", "0x")} a rug?`, {})).toEqual({
      address: token,
      chain: chains.robinhood,
    });
    expect(findToken(`Check ${token} on Base please`, {})?.chain.name).toBe("Base");
    expect(findToken(`https://dexscreener.com/ethereum/${token}`, {})?.chain.name).toBe("Ethereum");
    expect(findToken("check this", { token, chain: "arbitrum" })?.chain.name).toBe("Arbitrum");
    // A 64-character transaction or pool hash is not a token address.
    expect(findToken(`tx 0x${"a".repeat(64)}`, {})).toBeNull();
    expect(findToken("Is LIEGE safe?", {})).toBeNull();
  });

  test("a clean token gets no red flags, without ignoring pools and burns", () => {
    const outcome = assess(facts(clean));
    expect(outcome.verdict).toBe("No major red flags");
    expect(outcome.score).toBe(0);
    const concentration = outcome.checks.find((check) => check.label === "Holder concentration");
    // Only the two real wallets count: 4% + 3%.
    expect(concentration).toMatchObject({ status: "pass" });
    expect(concentration?.detail).toContain("7.0%");
    expect(outcome.checks.find((check) => check.label === "Ownership renounced")?.status).toBe(
      "pass",
    );
  });

  test("a honeypot with owner powers is high risk, whatever the model says", () => {
    const outcome = assess(
      facts(
        {
          ...clean,
          is_honeypot: "1",
          owner_address: "0x3333333333333333333333333333333333333333",
          is_mintable: "1",
          owner_change_balance: "1",
          sell_tax: "0.35",
          creator_percent: "0.4",
        },
        [
          {
            ...pair,
            liquidity: { usd: 3_000 },
            pairCreatedAt: now - 3_600_000,
            txns: { h24: { buys: 40, sells: 0 } },
          },
        ],
      ),
    );
    expect(outcome.verdict).toBe("High risk");
    expect(outcome.score).toBe(100);
    const labels = outcome.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Honeypot",
        "Sell tax",
        "Owner can edit balances",
        "Creator holdings",
        "Liquidity",
        "No sells",
      ]),
    );
    expect(outcome.checks.find((check) => check.label === "Mintable")?.status).toBe("warn");
    expect(outcome.checks.find((check) => check.label === "New pool")?.status).toBe("warn");
  });

  test("never guesses without data, and catches an address with no contract", () => {
    expect(assess(facts(null, []))).toMatchObject({ verdict: "Not enough data", score: null });
    expect(assess({ ...facts(null, []), isContract: false }).verdict).toBe("Not a token");
  });

  test("reads GoPlus, DexScreener, and the chain, keeping only pools on the token's chain", async () => {
    const { calls, fetcher } = network(clean, [
      pair,
      { ...pair, chainId: "base", liquidity: { usd: 9e9 } },
    ]);
    const read = await readToken({ address: token, chain: chains.robinhood }, fetcher);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toBe(
      `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${token}`,
    );
    expect(read.pairs).toHaveLength(1);
    expect(read.isContract).toBe(true);
    expect(read.security?.token_symbol).toBe("LIEGE");
    // Other chains have no RPC call.
    const other = network(clean);
    await readToken({ address: token, chain: chains.base }, other.fetcher);
    expect(other.calls).toHaveLength(2);
  });

  test("delivers a report with the fixed verdict, the model's read, and the sources", async () => {
    const prompts: string[] = [];
    const { fetcher } = network(clean);
    const result = await createConstantineHandler(async (system, user) => {
      expect(system).toBe(constantineSystemPrompt);
      prompts.push(user);
      return "<think>x</think>I found no known red flags — liquidity is deep.";
    }, fetcher).execute({ jobId: "job-1", brief: `Rug check ${token}`, requirements: {} });
    expect(prompts[0]).toContain("Verdict: No major red flags");
    expect(result.decline).toBeUndefined();
    expect(result.deliverable).toContain("# Rug check: LIEGE (Liege Agents)");
    expect(result.deliverable).toContain("**Verdict: No major red flags** · Risk score 0/100");
    expect(result.deliverable).toContain("I found no known red flags - liquidity is deep.");
    expect(result.deliverable).toContain("not financial advice");
    expect(result.evidence).toEqual([
      "https://dexscreener.com/robinhood/0xpool",
      `https://gopluslabs.io/token-security/4663/${token}`,
    ]);
    expect(result.metadata).toMatchObject({
      agentKey: "constantine",
      verdict: "No major red flags",
      riskScore: 0,
    });
  });

  test("still delivers when the model is down, and declines a request with no address", async () => {
    const { fetcher } = network({ ...clean, is_honeypot: "1" });
    const result = await createConstantineHandler(async () => {
      throw new Error("Groq is down");
    }, fetcher).execute({ jobId: "job-2", brief: `Check ${token}`, requirements: {} });
    expect(result.deliverable).toContain("**Verdict: High risk**");
    expect(result.deliverable).toContain("The biggest problem I found: Simulated sells fail");

    let called = false;
    const none = await createConstantineHandler(async () => {
      called = true;
      return "";
    }, fetcher).execute({ jobId: "job-3", brief: "Is LIEGE a rug?", requirements: {} });
    expect(none.decline).toContain("contract address");
    expect(called).toBe(false);
  });

  test("says plainly when no data exists instead of scoring", async () => {
    const { fetcher } = network(null, [], "0x");
    let called = false;
    const result = await createConstantineHandler(async () => {
      called = true;
      return "";
    }, fetcher).execute({ jobId: "job-4", brief: `Check ${token}`, requirements: {} });
    expect(called).toBe(false);
    expect(result.deliverable).toContain("**Verdict: Not a token**");
    expect(result.deliverable).toContain(
      "There is no contract at this address on Robinhood Chain.",
    );
  });

  test("a watchlist run carries the signals Liege compares, from the watched token", async () => {
    const { fetcher } = network({
      ...clean,
      sell_tax: "0.04",
      lp_holders: [
        { address: "0x000000000000000000000000000000000000dEaD", percent: "0.6" },
        { address: "0x4444444444444444444444444444444444444444", percent: "0.3", is_locked: 1 },
        { address: "0x5555555555555555555555555555555555555555", percent: "0.1" },
      ],
    });
    const result = await createConstantineHandler(async () => "Nothing serious.", fetcher).execute({
      jobId: "job-5",
      brief: "Watchlist check: re-check the saved token.",
      requirements: { watch: true, token, chain: "robinhood", scheduleId: "schedule-1" },
    });
    expect(result.deliverable).toContain("A daily watchlist check");
    expect(result.watch).toEqual({
      version: 1,
      symbol: "LIEGE",
      verdict: "No major red flags",
      riskScore: 0,
      honeypot: false,
      cannotSellAll: null,
      noSells: false,
      owner: "0x0000000000000000000000000000000000000000",
      hiddenOwner: false,
      canTakeBackOwnership: null,
      liquidityUsd: 45_000,
      lpLockedShare: 0.9,
      buyTax: 0,
      sellTax: 0.04,
      transferTax: null,
    });

    // An ordinary rug check sends no watch result and no watchlist note.
    const plain = await createConstantineHandler(async () => "Fine.", fetcher).execute({
      jobId: "job-6",
      brief: `Rug check ${token}`,
      requirements: {},
    });
    expect(plain.watch).toBeUndefined();
    expect(plain.deliverable).not.toContain("watchlist");
  });

  test("a pool that vanished reads as no liquidity; a market source that failed reads as unknown", async () => {
    const emptied = await readToken(
      { address: token, chain: chains.robinhood },
      network(clean, []).fetcher,
    );
    expect(watchSnapshot(emptied, assess(emptied)).liquidityUsd).toBe(0);

    const failing = async (url: string) =>
      url.includes("dexscreener")
        ? new Response("busy", { status: 503 })
        : network(clean).fetcher(url);
    const unknown = await readToken({ address: token, chain: chains.robinhood }, failing);
    expect(unknown.marketRead).toBe(false);
    const snapshot = watchSnapshot(unknown, assess(unknown));
    expect(snapshot.liquidityUsd).toBeNull();
    expect(snapshot.noSells).toBeNull();
    // GoPlus still answered, so its signals are known.
    expect(snapshot.honeypot).toBe(false);
  });
});
