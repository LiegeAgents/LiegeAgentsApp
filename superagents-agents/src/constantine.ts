import { config } from "./config.js";
import { generate } from "./groq.js";
import { revisionPrompt } from "./types.js";
import type { SuperAgentHandler } from "./types.js";

export const constantineServiceSlugs = ["rug-check"];

type Chain = { id: string; name: string; dexscreener: string };

/** Chains both data sources cover. Robinhood Chain is the default: it is where Liege lives. */
export const chains: Record<string, Chain> = {
  robinhood: { id: "4663", name: "Robinhood Chain", dexscreener: "robinhood" },
  ethereum: { id: "1", name: "Ethereum", dexscreener: "ethereum" },
  base: { id: "8453", name: "Base", dexscreener: "base" },
  arbitrum: { id: "42161", name: "Arbitrum", dexscreener: "arbitrum" },
  bsc: { id: "56", name: "BNB Chain", dexscreener: "bsc" },
};
const aliases: Record<string, string> = { eth: "ethereum", bnb: "bsc", arb: "arbitrum" };

const addressPattern = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const burnAddresses = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
]);

/** The token to check: the first contract address in the request, and the chain it names. */
export function findToken(text: string, requirements: unknown) {
  const policy = (requirements ?? {}) as Record<string, unknown>;
  const address = (typeof policy.token === "string" ? policy.token : text).match(
    addressPattern,
  )?.[0];
  if (!address) return null;
  const named =
    (typeof policy.chain === "string" ? policy.chain : "") ||
    text.match(/dexscreener\.com\/([a-z]+)\//i)?.[1] ||
    text.match(/\b(?:on|chain:?)\s+(robinhood|ethereum|eth|base|arbitrum|arb|bsc|bnb)\b/i)?.[1] ||
    "robinhood";
  const key = aliases[named.toLowerCase()] ?? named.toLowerCase();
  return { address: address.toLowerCase(), chain: chains[key] ?? chains.robinhood };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type GoPlusHolder = {
  address?: string;
  percent?: string;
  is_locked?: number;
  is_contract?: number;
};
export type GoPlusToken = Record<string, unknown> & {
  token_name?: string;
  token_symbol?: string;
  holders?: GoPlusHolder[];
  lp_holders?: GoPlusHolder[];
  dex?: Array<{ pair?: string; pool_manager?: string }>;
};
export type DexPair = {
  chainId: string;
  url?: string;
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  fdv?: number;
  pairCreatedAt?: number;
};
export type TokenFacts = {
  address: string;
  chain: Chain;
  security: GoPlusToken | null;
  pairs: DexPair[];
  // Robinhood Chain only: whether code is deployed at the address. Null when not checked.
  isContract: boolean | null;
  // Whether DexScreener answered: with an answer, no pools means no pools, not a failed source.
  marketRead?: boolean;
  checkedAt: string;
};

async function getJson(fetcher: Fetch, url: string, init?: RequestInit) {
  try {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return response.ok ? ((await response.json()) as unknown) : null;
  } catch {
    return null;
  }
}

/** Reads the token's live security, market, and contract data. A source that fails is left out. */
export async function readToken(
  token: { address: string; chain: Chain },
  fetcher: Fetch = fetch,
): Promise<TokenFacts> {
  const { address, chain } = token;
  const [security, market, code] = await Promise.all([
    getJson(
      fetcher,
      `https://api.gopluslabs.io/api/v1/token_security/${chain.id}?contract_addresses=${address}`,
    ),
    getJson(fetcher, `https://api.dexscreener.com/latest/dex/tokens/${address}`),
    chain.id === chains.robinhood.id
      ? getJson(fetcher, config.rhcRpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_getCode",
            params: [address, "latest"],
          }),
        })
      : Promise.resolve(null),
  ]);
  const result = (security as { result?: Record<string, GoPlusToken> } | null)?.result;
  const found = result?.[address] ?? Object.values(result ?? {})[0];
  const pairs = ((market as { pairs?: DexPair[] } | null)?.pairs ?? [])
    .filter((pair) => pair.chainId === chain.dexscreener)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const bytecode = (code as { result?: unknown } | null)?.result;
  return {
    address,
    chain,
    security: found && Object.keys(found).length ? found : null,
    pairs,
    isContract: typeof bytecode === "string" ? bytecode.length > 2 : null,
    marketRead: market !== null,
    checkedAt: new Date().toISOString(),
  };
}

export type Check = {
  status: "fail" | "warn" | "pass";
  label: string;
  detail: string;
  critical?: boolean;
};

const flag = (value: unknown) =>
  value === "1" || value === 1 ? true : value === "0" || value === 0 ? false : null;
const ratio = (value: unknown) => {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const percent = (value: number) =>
  value === 0 ? "0%" : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
const usd = (value: number) =>
  `$${value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : value.toFixed(2)}`;

/**
 * Turns the facts into checks with a fixed rule set, so the verdict and score never depend on the
 * model. The model only explains them.
 */
export function assess(facts: TokenFacts) {
  const checks: Check[] = [];
  const add = (status: Check["status"], label: string, detail: string, critical = false) =>
    checks.push({ status, label, detail, ...(critical ? { critical } : {}) });
  const s = facts.security ?? {};
  const bool = (key: string) => flag(s[key]);

  if (facts.isContract === false)
    add("fail", "No contract", `Nothing is deployed at this address on ${facts.chain.name}.`, true);
  if (facts.security) {
    if (bool("is_honeypot"))
      add("fail", "Honeypot", "Simulated sells fail: buyers cannot sell.", true);
    else if (bool("is_honeypot") === false)
      add("pass", "Sellable", "A simulated sell went through.");
    if (bool("cannot_sell_all"))
      add("fail", "Sell limit", "Holders cannot sell their whole balance.", true);
    if (bool("cannot_buy")) add("warn", "Buying blocked", "The contract can block buys.");
    if (bool("honeypot_with_same_creator"))
      add("fail", "Creator history", "The same creator deployed a known honeypot.", true);

    for (const [key, label] of [
      ["buy_tax", "Buy tax"],
      ["sell_tax", "Sell tax"],
      ["transfer_tax", "Transfer tax"],
    ] as const) {
      const tax = ratio(s[key]);
      if (tax === null) continue;
      if (tax > 0.1) add("fail", label, `${percent(tax)} on every trade.`, tax >= 0.5);
      else if (tax > 0.05) add("warn", label, `${percent(tax)} on every trade.`);
    }

    const owner = typeof s.owner_address === "string" ? s.owner_address.toLowerCase() : "";
    const renounced = owner !== "" && burnAddresses.has(owner);
    if (renounced) add("pass", "Ownership renounced", "No owner can change the contract.");
    const powers: Array<[string, string, string, boolean]> = [
      [
        "hidden_owner",
        "Hidden owner",
        "Someone keeps owner powers after ownership looks renounced.",
        true,
      ],
      [
        "can_take_back_ownership",
        "Ownership can be reclaimed",
        "A renounced owner can take control back.",
        true,
      ],
      [
        "owner_change_balance",
        "Owner can edit balances",
        "The owner can change any holder's balance.",
        true,
      ],
      ["selfdestruct", "Self-destruct", "The contract can destroy itself.", true],
      ["is_mintable", "Mintable", "New tokens can be minted, diluting holders.", false],
      ["transfer_pausable", "Transfers can pause", "Trading can be frozen.", false],
      ["is_blacklisted", "Blacklist", "Specific wallets can be blocked from trading.", false],
      [
        "slippage_modifiable",
        "Tax can change",
        "The trading tax can be raised after you buy.",
        false,
      ],
      [
        "personal_slippage_modifiable",
        "Per-wallet tax",
        "A different tax can be set for specific wallets.",
        false,
      ],
      [
        "trading_cooldown",
        "Trading cooldown",
        "The contract can force waits between trades.",
        false,
      ],
      ["is_proxy", "Upgradeable", "The code behind the token can be replaced.", false],
      [
        "external_call",
        "External calls",
        "Transfers call other contracts that can change behavior.",
        false,
      ],
    ];
    // Renouncing ends owner powers, but not a proxy admin's or another contract's.
    for (const [key, label, detail, critical] of powers) {
      if (!bool(key)) continue;
      const defused = renounced && !critical && key !== "is_proxy" && key !== "external_call";
      add(
        critical ? "fail" : defused ? "pass" : "warn",
        label,
        defused ? `${detail} The owner has renounced.` : detail,
        critical,
      );
    }
    if (bool("is_open_source") === false)
      add("fail", "Unverified code", "The source code is not published, so it cannot be reviewed.");
    else if (bool("is_open_source")) add("pass", "Verified code", "The source code is published.");

    const creator = ratio(s.creator_percent);
    if (creator !== null) {
      if (creator > 0.2) add("fail", "Creator holdings", `The creator holds ${percent(creator)}.`);
      else if (creator > 0.05)
        add("warn", "Creator holdings", `The creator holds ${percent(creator)}.`);
      else add("pass", "Creator holdings", `The creator holds ${percent(creator)}.`);
    }

    // Pools, LP positions, burns, and locks are not people who can dump.
    const pools = new Set(
      [
        ...(s.dex ?? []).flatMap((dex) => [dex.pair, dex.pool_manager]),
        ...(s.lp_holders ?? []).map((holder) => holder.address),
        ...facts.pairs.map((pair) => pair.pairAddress),
      ]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase()),
    );
    const holders = (s.holders ?? []).filter(
      (holder) =>
        holder.address &&
        !holder.is_locked &&
        !burnAddresses.has(holder.address.toLowerCase()) &&
        !pools.has(holder.address.toLowerCase()),
    );
    if (s.holders?.length) {
      const top = holders
        .slice(0, 10)
        .reduce((sum, holder) => sum + (ratio(holder.percent) ?? 0), 0);
      const count = ratio(s.holder_count);
      const detail = `The top ${Math.min(10, holders.length)} wallets hold ${percent(top)}${count ? ` across ${count.toLocaleString("en-US")} holders` : ""}, not counting pools, burns, and locks.`;
      add(top > 0.5 ? "fail" : top > 0.3 ? "warn" : "pass", "Holder concentration", detail);
    }
    if (s.lp_holders?.length) {
      const locked = lpLockedShare(s);
      add(
        locked >= 0.9 ? "pass" : "warn",
        "Liquidity lock",
        locked >= 0.9
          ? `${percent(locked)} of the tracked liquidity is locked or burned.`
          : `${percent(locked)} of the tracked liquidity is locked or burned; the rest can be withdrawn.`,
      );
    }
  }

  const main = facts.pairs[0];
  if (main) {
    const liquidity = facts.pairs.reduce((sum, pair) => sum + (pair.liquidity?.usd ?? 0), 0);
    add(
      liquidity < 5_000 ? "fail" : liquidity < 25_000 ? "warn" : "pass",
      "Liquidity",
      `${usd(liquidity)} across ${facts.pairs.length} pool${facts.pairs.length === 1 ? "" : "s"}.`,
    );
    if (main.pairCreatedAt) {
      const hours = (Date.parse(facts.checkedAt) - main.pairCreatedAt) / 3_600_000;
      if (hours < 24)
        add("warn", "New pool", `The main pool is ${Math.max(0, Math.round(hours))} hours old.`);
    }
    const buys = main.txns?.h24?.buys ?? 0;
    const sells = main.txns?.h24?.sells ?? 0;
    if (buys >= 10 && sells === 0)
      add(
        "fail",
        "No sells",
        `${buys} buys and no sells in 24 hours: selling may be blocked.`,
        true,
      );
  } else if (facts.security || facts.isContract) {
    add("warn", "No market", `No trading pool was found on ${facts.chain.name}.`);
  }

  const failures = checks.filter((check) => check.status === "fail");
  const warnings = checks.filter((check) => check.status === "warn");
  const score = Math.min(
    100,
    failures.reduce((sum, check) => sum + (check.critical ? 40 : 25), 0) + warnings.length * 8,
  );
  const known = Boolean(facts.security || main);
  const verdict =
    facts.isContract === false
      ? "Not a token"
      : !known
        ? "Not enough data"
        : failures.some((check) => check.critical) || score >= 60
          ? "High risk"
          : score >= 25
            ? "Caution"
            : "No major red flags";
  return { checks, score: known ? score : null, verdict };
}

// Rounded so shares such as 0.6 + 0.3 compare as 0.9, not 0.8999….
const lpLockedShare = (security: GoPlusToken) =>
  Math.round(
    (security.lp_holders ?? [])
      .filter(
        (holder) => holder.is_locked || burnAddresses.has(String(holder.address).toLowerCase()),
      )
      .reduce((sum, holder) => sum + (ratio(holder.percent) ?? 0), 0) * 1e6,
  ) / 1e6;
const share = (value: unknown) => {
  const number = ratio(value);
  return number === null ? null : Math.min(1, Math.max(0, number));
};

/**
 * The watchlist's view of one check: the signals Liege compares run to run. Null means the
 * source did not say on this run, which never raises an alert.
 */
export function watchSnapshot(facts: TokenFacts, outcome: ReturnType<typeof assess>) {
  const s = facts.security;
  const main = facts.pairs[0];
  const owner = typeof s?.owner_address === "string" ? s.owner_address.toLowerCase() : null;
  const symbol = s?.token_symbol ?? main?.baseToken?.symbol ?? null;
  return {
    version: 1 as const,
    symbol: symbol ? String(symbol).trim().slice(0, 40) || null : null,
    verdict: outcome.verdict,
    riskScore: outcome.score,
    honeypot: s ? flag(s.is_honeypot) : null,
    cannotSellAll: s ? flag(s.cannot_sell_all) : null,
    noSells: main ? (main.txns?.h24?.buys ?? 0) >= 10 && (main.txns?.h24?.sells ?? 0) === 0 : null,
    owner: owner !== null && /^(0x[0-9a-f]{40})?$/.test(owner) ? owner : null,
    hiddenOwner: s ? flag(s.hidden_owner) : null,
    canTakeBackOwnership: s ? flag(s.can_take_back_ownership) : null,
    liquidityUsd: facts.pairs.length
      ? facts.pairs.reduce((sum, pair) => sum + (pair.liquidity?.usd ?? 0), 0)
      : facts.marketRead
        ? 0
        : null,
    lpLockedShare: s?.lp_holders?.length ? Math.min(1, lpLockedShare(s)) : null,
    buyTax: s ? share(s.buy_tax) : null,
    sellTax: s ? share(s.sell_tax) : null,
    transferTax: s ? share(s.transfer_tax) : null,
  };
}

const name = (facts: TokenFacts) => {
  const symbol = facts.security?.token_symbol ?? facts.pairs[0]?.baseToken?.symbol;
  const title = facts.security?.token_name ?? facts.pairs[0]?.baseToken?.name;
  return symbol ? `${symbol}${title && title !== symbol ? ` (${title})` : ""}` : "this token";
};

/** Public pages that show the same data the report used. */
export function sourcesFor(facts: TokenFacts) {
  return [
    ...(facts.pairs[0]?.url ? [facts.pairs[0].url] : []),
    ...(facts.security
      ? [`https://gopluslabs.io/token-security/${facts.chain.id}/${facts.address}`]
      : []),
  ];
}

export function renderReport(
  facts: TokenFacts,
  outcome: ReturnType<typeof assess>,
  summary: string,
  watch = false,
) {
  const group = (status: Check["status"]) =>
    outcome.checks
      .filter((check) => check.status === status)
      .map((check) => `- **${check.label}:** ${check.detail}`)
      .join("\n");
  const main = facts.pairs[0];
  const market = main
    ? [
        main.priceUsd ? `- Price: $${main.priceUsd}` : "",
        `- Liquidity: ${usd(facts.pairs.reduce((sum, pair) => sum + (pair.liquidity?.usd ?? 0), 0))}`,
        main.volume?.h24 !== undefined ? `- 24h volume: ${usd(main.volume.h24)}` : "",
        main.txns?.h24
          ? `- 24h trades: ${main.txns.h24.buys ?? 0} buys, ${main.txns.h24.sells ?? 0} sells`
          : "",
        main.fdv ? `- Fully diluted value: ${usd(main.fdv)}` : "",
        main.pairCreatedAt
          ? `- Main pool created: ${new Date(main.pairCreatedAt).toISOString().slice(0, 10)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const sections = [
    `# Rug check: ${name(facts)}`,
    `**Verdict: ${outcome.verdict}**${outcome.score === null ? "" : ` · Risk score ${outcome.score}/100`}\n${facts.chain.name} · \`${facts.address}\` · checked ${facts.checkedAt.slice(0, 16).replace("T", " ")} UTC`,
    `## Constantine's read\n${summary}`,
    group("fail") && `## Red flags\n${group("fail")}`,
    group("warn") && `## Watch\n${group("warn")}`,
    group("pass") && `## Passed\n${group("pass")}`,
    market && `## Market\n${market}`,
    sourcesFor(facts).length &&
      `## Sources\n${sourcesFor(facts)
        .map((url) => `- ${url}`)
        .join("\n")}`,
    watch &&
      "_A daily watchlist check: Liege compares it with the previous check and alerts you only if ownership, liquidity, a tax, or a honeypot flag got worse._",
    "_An automated risk screen from live onchain data, not financial advice or a guarantee. A clean result means no known red flags were found, not that the token is safe._",
  ];
  return sections.filter(Boolean).join("\n\n");
}

export const constantineSystemPrompt = `You are Constantine by LiegeAgents, a token risk analyst operated by the Liege team. You check tokens for rug-pull risk before people buy.

You receive the facts of one rug check: the verdict and risk score, already decided by fixed rules, the checks behind them, and market data. Write "Constantine's read": 3 to 5 plain sentences for the client.

- Lead with what matters most for someone about to buy: the biggest red flag, or why nothing serious showed up.
- Use only the facts given. Never invent numbers, owners, team details, audits, or news. Never change the verdict or score.
- Never tell the client to buy or sell, and never predict the price. You may say what to watch or verify next.
- A clean result is never "safe": say no known red flags were found.
- No headings, no lists, no emojis. Speak in first person as Constantine.`;

export function cleanText(raw: string) {
  return raw
    .replace(/<(?:think|thought)>[\s\S]*?<\/(?:think|thought)>/gi, "")
    .replace(/\s*[—–]\s*/g, " - ")
    .trim();
}

const fallbackSummary = (outcome: ReturnType<typeof assess>) => {
  const fails = outcome.checks.filter((check) => check.status === "fail");
  const warns = outcome.checks.filter((check) => check.status === "warn");
  return fails.length
    ? `The biggest problem I found: ${fails[0].detail} ${fails.length > 1 ? `There ${fails.length - 1 === 1 ? "is" : "are"} ${fails.length - 1} more red flag${fails.length - 1 === 1 ? "" : "s"} below.` : ""}`.trim()
    : warns.length
      ? `I found no critical red flags, but ${warns.length} thing${warns.length === 1 ? "" : "s"} below deserve${warns.length === 1 ? "s" : ""} a look before you buy.`
      : "I found no known red flags in the contract, holders, or liquidity. That is not a guarantee: keep position sizes sensible.";
};

export function createConstantineHandler(
  generateRead: typeof generate = generate,
  fetcher: Fetch = fetch,
): SuperAgentHandler {
  return {
    agentKey: "constantine",
    serviceSlugs: constantineServiceSlugs,
    async execute({ jobId, brief, requirements, revision, attachments, report }) {
      const token = findToken(`${brief}\n${attachments?.text ?? ""}`, requirements);
      // Nothing to check: decline so the client is refunded instead of paying for a non-answer.
      if (!token)
        return {
          deliverable: "",
          decline:
            "Constantine needs the token's contract address (0x followed by 40 characters) to run a rug check. You have been refunded; post the job again with the address.",
        };
      await report?.(
        "reviewing",
        `Constantine is reading the contract, holders, and liquidity on ${token.chain.name}.`,
        55,
      );
      const facts = await readToken(token, fetcher);
      const outcome = assess(facts);
      let summary = fallbackSummary(outcome);
      if (outcome.score !== null) {
        try {
          const read = cleanText(
            await generateRead(
              constantineSystemPrompt,
              `Job ID: ${jobId}\nToken: ${name(facts)} on ${facts.chain.name}\nVerdict: ${outcome.verdict}\nRisk score: ${outcome.score}/100\nChecks:\n${outcome.checks.map((check) => `- [${check.status}] ${check.label}: ${check.detail}`).join("\n")}\n\nThe client's request, for context only:\n${brief.slice(0, 2_000)}${revision ? revisionPrompt(revision) : ""} /no_think`,
            ),
          );
          if (read) summary = read;
        } catch (error) {
          console.warn(
            JSON.stringify({
              event: "constantine.read_failed",
              jobId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      } else {
        summary =
          outcome.verdict === "Not a token"
            ? `There is no contract at this address on ${facts.chain.name}. Check the address and the chain: if it is on another chain, say which one in the request.`
            : `I could not find security or market data for this address on ${facts.chain.name}. It may be brand new, not yet traded, or on another chain; say which chain in the request. I will not guess at a verdict without data.`;
      }
      const watching = (requirements as { watch?: unknown } | null)?.watch === true;
      return {
        deliverable: renderReport(facts, outcome, summary, watching),
        evidence: sourcesFor(facts),
        ...(watching ? { watch: watchSnapshot(facts, outcome) } : {}),
        metadata: {
          model: "groq",
          agentKey: "constantine",
          serviceSlug: "rug-check",
          chain: facts.chain.name,
          token: facts.address,
          verdict: outcome.verdict,
          riskScore: outcome.score,
          redFlags: outcome.checks.filter((check) => check.status === "fail").length,
        },
      };
    },
  };
}
