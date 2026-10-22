#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { verifyReceipt } from "./receipts.js";
import {
  clearCredentials,
  credentialsPath,
  linkedAccessToken,
  loadCredentials,
  saveCredentials,
} from "./credentials.js";

export type Json = Record<string, unknown>;

export const getApiUrl = () =>
  (process.env.LIEGE_API_URL ?? "https://api.liegeagents.com").replace(/\/$/, "");
export const getSessionToken = () => process.env.LIEGE_SESSION_TOKEN;

const BOOLEAN_FLAGS = new Set(["ap2", "help", "h", "auto-fund", "fund", "no-comment"]);
const INSTALLER_URL =
  "https://raw.githubusercontent.com/LiegeAgents/LiegeAgentsApp/main/cli/install.sh";

export function usage(): never {
  console.log(`Liege operator CLI

Usage:
  liege --spg
  liege login [<pairing-code>] [--name <device-name>]
  liege logout
  liege health
  liege upgrade [latest|<version>]
  liege agents list
  liege agents reputation <slug>
  liege agents get <slug>
  liege superagents chat
  liege superagents dashboard
  liege superagents enrollments
  liege superagents enroll <agent-id> <service-id> <webhook-id> --assets usdg,liege
  liege superagents verify <agent-id>
  liege superagents discovery <agent-id> --enable|--disable
  liege superagents runtime-token create
  liege superagents runtime-token list
  liege superagents runtime-token revoke <token-id>
  liege superagents schedules list
  liege superagents schedules get <schedule-id>
  liege superagents schedules create --agent-id <id> --request <text> --budget <n> --cadence <daily|weekly|monthly> --cap <n> [--max-runs <n>] [--auto-fund] [--asset usdg|liege] [--start <iso-time>]
  liege superagents schedules pause|resume|cancel <schedule-id>
  liege superagents auctions create --request <text> [--max-budget <n>] [--minutes <1-60>] [--asset usdg|liege]
  liege superagents auctions list
  liege superagents auctions get <auction-id>
  liege superagents auctions award <auction-id> <bid-id> [--fund]
  liege superagents auctions cancel <auction-id>
  liege superagents triggers create --agent-id <id> --repo <owner/repo> --budget <n> --cap <n> [--branch <name>] [--instructions <text>] [--auto-fund] [--no-comment] [--asset usdg|liege]
  liege superagents triggers list
  liege superagents triggers get <trigger-id>
  liege superagents triggers pause|resume|cancel <trigger-id>
  liege superagents onchain create --agent-id <id> --token <0x…> --budget <n> --cap <n> [--min <tokens>] [--address <0x…>] [--cooldown <minutes>] [--max-per-day <n>] [--instructions <text>] [--auto-fund] [--asset usdg|liege]
  liege superagents onchain create --agent-id <id> --contract <0x…> --event "<Event(type indexed name, …)>" --budget <n> --cap <n> [...]
  liege superagents onchain list
  liege superagents onchain get|pause|resume|cancel <trigger-id>
  liege superagents squads list
  liege superagents squads get <squad-id>
  liege superagents squads create --request <text> --steps "<agent>:<budget>:<task>; ..." [--name <text>] [--auto-fund] [--asset usdg|liege]
  liege superagents squads cancel <squad-id>
  liege calls make <agent-id> --input <text> [--asset usdg|liege] [--key <idempotency-key>]
  liege calls list [--limit <n>]
  liege calls get <call-id>
  liege calls price <agent-id> [--usdg <amount|off>] [--liege <amount|off>]
  liege watchlist [list]
  liege watchlist get <watch-id>
  liege watchlist pause|resume|cancel <watch-id>
  liege jobs list [--status <status>] [--asset <usdg|liege>] [--limit <n>]
  liege jobs get <job-id>
  liege jobs simulate '<json-job>'
  liege jobs funding-quote <job-id>
  liege jobs fund <job-id> [--quote-id <id>] [--gas-tx-hash <hash>] [--token-tx-hash <hash>] [--usdg-tx-hash <hash>]
  liege jobs submit <job-id> '<json-deliverable>'
  liege jobs evaluate <job-id> '<json-decision>'
  liege jobs decline <job-id> --reason <text>
  liege jobs revise <job-id> --feedback <text>
  liege jobs revision <job-id>
  liege jobs attach <job-id> --file <path> | --url <url> [--commit <sha>]
  liege jobs attachments <job-id>
  liege jobs attachment <job-id> <attachment-id> [--out <path>]
  liege jobs detach <job-id> <attachment-id>
  liege jobs receipt <job-id> [--rpc <url>]
  liege runner simulate <agent-id> '<json-workload>'
  liege runner authorize <agent-id> '<json-workload>' --simulation-id <id>
  liege runner execute '<json-workload>' --action-id <id> --simulation-id <id>
  liege runner list [--agent-id <id>]
  liege runner status <run-id>
  liege runner artifact <run-id> <artifact-id>
  liege invoices list
  liege invoices issue '<json-invoice>'
  liege invoices pay <invoice-id>
  liege invoices refund <invoice-id>
  liege invoices cancel <invoice-id>
  liege account list
  liege account status <agent-id>
  liege account pause <agent-id> [--reason <text>]
  liege account resume <agent-id>
  liege account kill <agent-id> [--reason <text>]
  liege account mandates <agent-id> [mandate-id] [--format ap2]
  liege account policy set <agent-id> '<json-policy>'
  liege services list [--agent-id <id>] [--type <tool|data|skill>] [--limit <n>]
  liege services get <agent-id> <slug>
  liege services create '<json-service>' | [flags]
  liege mcp connections
  liege mcp revoke <connection-id>
  liege hire-keys create <name> --max-per-hire <usdg> --daily <usdg> [--days <n>]
  liege hire-keys list
  liege hire-keys revoke <key-id>
  liege policy get <agent-id>
  liege policy set <agent-id> '<json-policy>'
  liege proposals list [--status pending|approved|rejected|expired]
  liege proposals get <proposal-id>
  liege proposals wait <proposal-id> [--timeout-ms <n>] [--poll-ms <n>]
  liege proposals approve <proposal-id>
  liege proposals reject <proposal-id>

Environment:
  LIEGE_API_URL       API origin (default: https://api.liegeagents.com)
  LIEGE_SESSION_TOKEN Existing Liege bearer session token (overrides \`liege login\`)
  LIEGE_SUPERAGENTS_URL Super Agents dashboard (default: https://superagents.liegeagents.com)
`);
  process.exit(0);
}

export const NOT_SIGNED_IN =
  "Not signed in. Run `liege login` with a pairing code from your Liege workspace, or set LIEGE_SESSION_TOKEN.";

export async function request(path: string, init: RequestInit = {}, authenticated = true) {
  const envToken = getSessionToken();
  // Linked device tokens are only sent (and refreshed) for commands that require sign-in.
  let token = envToken ?? (authenticated ? await linkedAccessToken(getApiUrl()) : undefined);
  if (authenticated && !token) throw new Error(NOT_SIGNED_IN);
  const send = () => {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${getApiUrl()}${path}`, { ...init, headers });
  };
  let response = await send();
  if (response.status === 401 && authenticated && token && !envToken) {
    // The linked access token may have been revoked or expired early; refresh once.
    token = await linkedAccessToken(getApiUrl(), true);
    response = await send();
  }
  const body = response.status === 204 ? null : ((await response.json()) as Json);
  if (!response.ok) {
    const details = (body?.error as Json | undefined) ?? {};
    const error = new Error(
      details.message ? String(details.message) : `API request failed (${response.status}).`,
    );
    Object.assign(error, {
      status: response.status,
      code: details.code,
      requestId: response.headers.get("x-request-id") ?? details.requestId,
      retryable: response.status === 429 || response.status >= 500,
    });
    throw error;
  }
  return body?.data ?? body;
}

const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "text/plain",
};

/** The upload type for a file attachment, from its extension; the API checks the contents. */
export function attachmentMediaType(path: string) {
  const type = ATTACHMENT_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
  if (!type)
    throw new Error(
      "Attach a PDF, PNG, JPEG, GIF, WebP, or text file (.txt, .md, .csv, .json), up to 3 MB.",
    );
  return type;
}

/** Attaches a local file or an https link to an open job's brief. */
export async function attach(jobId: string, flags: Record<string, string | undefined>) {
  const path = `/v1/jobs/${encodeURIComponent(jobId)}/attachments`;
  if (flags.url)
    return request(path, {
      method: "POST",
      body: JSON.stringify({ url: flags.url, ...(flags.commit ? { commit: flags.commit } : {}) }),
    });
  if (!flags.file) throw new Error("Provide --file <path> or --url <url> to attach.");
  const file = Bun.file(flags.file);
  if (!(await file.exists())) throw new Error(`No file at ${flags.file}.`);
  return request(`${path}/file?name=${encodeURIComponent(basename(flags.file))}`, {
    method: "POST",
    headers: { "content-type": attachmentMediaType(flags.file) },
    body: await file.arrayBuffer(),
  });
}

type SquadAgent = { id: string; name: string };

/**
 * Squad steps from "Anna:2:Research the market; Daniel:3:Plan the launch". An agent is named by
 * its id or the start of its name.
 */
export function squadSteps(spec: string, agents: SquadAgent[]) {
  return spec
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [who = "", budget = "", ...task] = part.split(":");
      const name = who.trim().toLowerCase();
      const agent = agents.find(
        (item) => item.id === who.trim() || item.name.toLowerCase().startsWith(name),
      );
      if (!name || !agent) throw new Error(`No Super Agent matches "${who.trim()}".`);
      if (!(Number(budget) > 0) || !task.join(":").trim())
        throw new Error(`Write each step as <agent>:<budget>:<task>, not "${part}".`);
      return { agentId: agent.id, task: task.join(":").trim(), budgetAmount: Number(budget) };
    });
}

/** A watch reduced to its latest check and its last alert, for `liege watchlist` and `/watchlist`. */
export function summarizeWatch(watch: Json) {
  // Runs arrive newest first; a run has a verdict once Constantine delivered its check.
  const runs = (watch.runs as Json[] | undefined) ?? [];
  const latest = runs.find((run) => run.verdict != null);
  const alert = runs.find((run) => ((run.changes as Json[] | undefined) ?? []).length > 0);
  return {
    id: String(watch.id),
    token: String(watch.watch_token),
    chain: String(watch.chain_name ?? watch.watch_chain),
    status: String(watch.status),
    settlementAsset: String(watch.settlement_asset ?? "usdg"),
    budgetAmount: String(watch.budget_amount),
    committedAmount: String(watch.committed_amount),
    spendCap: String(watch.spend_cap),
    nextCheckAt: watch.status === "active" ? ((watch.next_run_at as string | null) ?? null) : null,
    awaitingFunding: runs.filter(
      (run) => run.outcome === "awaiting_funding" && run.job_status === "open",
    ).length,
    latest: latest
      ? {
          verdict: String(latest.verdict),
          riskScore: latest.risk_score == null ? null : Number(latest.risk_score),
          baseline: latest.baseline === true,
          checkedAt: (latest.checked_at as string | null) ?? null,
          jobId: (latest.job_id as string | null) ?? null,
        }
      : null,
    lastAlert: alert
      ? {
          checkedAt: (alert.checked_at as string | null) ?? null,
          jobId: (alert.job_id as string | null) ?? null,
          changes: ((alert.changes as Json[]) ?? []).map((change) => String(change.detail)),
        }
      : null,
  };
}

export function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

export function normalizeUpgradeVersion(value = "latest") {
  if (value === "latest") return value;
  if (/^cli-v\d+\.\d+\.\d+$/.test(value)) return value;
  if (/^v?\d+\.\d+\.\d+$/.test(value)) return `cli-v${value.replace(/^v/, "")}`;
  throw new Error(
    "Upgrade version must be latest, v<major>.<minor>.<patch>, or cli-v<major>.<minor>.<patch>.",
  );
}

export async function upgrade(version = "latest") {
  if (process.platform === "win32")
    throw new Error(
      "Automatic upgrade is currently supported on macOS and Linux; reinstall the Windows release from GitHub Releases.",
    );
  const requestedVersion = normalizeUpgradeVersion(version);
  const response = await fetch(INSTALLER_URL);
  if (!response.ok) throw new Error(`Unable to download the Liege installer (${response.status}).`);
  const script = await response.text();
  const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "liege-upgrade-"));
  const path = join(directory, "install.sh");
  await Bun.write(path, script);
  try {
    const executable = basename(process.execPath);
    const env = { ...process.env };
    if (!env.LIEGE_INSTALL_DIR && executable === "liege")
      env.LIEGE_INSTALL_DIR = dirname(process.execPath);
    const child = Bun.spawn(["sh", path, requestedVersion], {
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Liege upgrade failed with exit code ${exitCode}.`);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  return { upgraded: true, version: requestedVersion };
}

export async function login(code?: string, name?: string) {
  let pairingCode = code?.trim();
  if (!pairingCode) {
    if (!process.stdin.isTTY) throw new Error("Pass the pairing code: liege login <8-digit-code>.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      pairingCode = (
        await rl.question(
          "Generate a pairing code in your Liege workspace (Settings → Pair a device), then enter it: ",
        )
      ).trim();
    } finally {
      rl.close();
    }
  }
  pairingCode = pairingCode.replace(/[\s-]/g, "");
  if (!/^\d{8}$/.test(pairingCode)) throw new Error("The pairing code must contain 8 digits.");
  const apiUrl = getApiUrl();
  const paired = (await request(
    "/v1/mobile/pair",
    {
      method: "POST",
      body: JSON.stringify({
        code: pairingCode,
        platform: "cli",
        name: (name?.trim() || `CLI on ${hostname()}`).slice(0, 80),
      }),
    },
    false,
  )) as Json;
  await saveCredentials({
    apiUrl,
    deviceId: String(paired.deviceId),
    accessToken: String(paired.accessToken),
    refreshToken: String(paired.refreshToken),
    accessExpiresAt: String(paired.accessExpiresAt),
    refreshExpiresAt: String(paired.refreshExpiresAt),
  });
  return { linked: true, deviceId: paired.deviceId, apiUrl, credentials: credentialsPath() };
}

export async function logout() {
  const stored = await loadCredentials(getApiUrl());
  let revoked = false;
  if (stored && !getSessionToken()) {
    // Revoke the device server-side so the stored refresh token stops working everywhere.
    revoked = await request(`/v1/mobile/devices/${encodeURIComponent(stored.deviceId)}`, {
      method: "DELETE",
    }).then(
      () => true,
      () => false,
    );
  }
  await clearCredentials();
  return { loggedOut: true, revoked };
}

export function parseFlags(args: string[]): {
  flags: Record<string, string>;
  positional: string[];
} {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = "true";
        } else {
          const next = args[i + 1];
          if (next !== undefined && !next.startsWith("--")) {
            flags[key] = next;
            i++;
          } else {
            flags[key] = "true";
          }
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function jsonArgument(value: string | undefined, label: string): Json {
  if (!value) throw new Error(`${label} must be provided as JSON.`);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Json;
  } catch {
    throw new Error(`The ${label} argument must be valid JSON.`);
  }
}

function digest(value: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, string>>((out, key) => {
        out[key] = value[key];
        return out;
      }, {}),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function runnerDetails(input: Json): Json {
  const env = (input.env as Record<string, string> | undefined) ?? {};
  const files = (input.files as Record<string, string> | undefined) ?? {};
  return {
    command: input.command,
    args: input.args ?? [],
    jobId: input.jobId ?? null,
    timeoutMs: input.timeoutMs ?? 30_000,
    maxOutputBytes: input.maxOutputBytes ?? 256_000,
    envDigest: digest(env),
    filesDigest: digest(files),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function execute(args: string[]): Promise<unknown> {
  const { flags, positional } = parseFlags(args);
  const [resource, action, id] = positional;

  if (!resource || resource === "--help" || resource === "-h" || flags.help === "true") usage();

  if (resource === "health") return request("/health", {}, false);
  if (resource === "login") return login(action ?? flags.code, flags.name);
  if (resource === "logout") return logout();
  if (resource === "upgrade") return upgrade(id ?? "latest");
  if (resource === "agents" && action === "list") return request("/v1/agents");
  if (resource === "agents" && (action === "reputation" || action === "audit") && id)
    return request(`/v1/agents/${encodeURIComponent(id)}/reputation`, {}, false);
  if (resource === "agents" && action === "get" && id)
    return request(`/v1/agents/${encodeURIComponent(id)}`, {}, false);
  if (resource === "superagents" || resource === "super-agents") {
    if (action === "dashboard") return request("/v1/super-agents/dashboard");
    if (action === "enrollments") return request("/v1/super-agents/enrollments");
    if (action === "enroll" && id && positional[3] && positional[4]) {
      const assets = (flags.assets ?? "usdg")
        .split(",")
        .map((asset) => asset.trim().toLowerCase())
        .filter(Boolean);
      if (!assets.length || assets.some((asset) => asset !== "usdg" && asset !== "liege"))
        throw new Error("--assets must contain one or both of: usdg,liege.");
      return request("/v1/super-agents/enrollments", {
        method: "POST",
        body: JSON.stringify({
          agentId: id,
          serviceId: positional[3],
          webhookId: positional[4],
          settlementAssets: [...new Set(assets)],
        }),
      });
    }
    if (action === "verify" && id)
      return request(`/v1/super-agents/enrollments/${encodeURIComponent(id)}/verify`, {
        method: "POST",
      });
    if (action === "discovery" && id) {
      const enabled =
        flags.enable === "true" || (flags.disable !== "true" && flags.enabled === "true");
      if (flags.enable !== "true" && flags.disable !== "true" && flags.enabled !== "true")
        throw new Error("Use --enable or --disable for Super Agent discovery.");
      return request(`/v1/super-agents/enrollments/${encodeURIComponent(id)}/discovery`, {
        method: "POST",
        body: JSON.stringify({ enabled }),
      });
    }
    if (action === "schedules" || action === "schedule") {
      const target = positional[3];
      const path = (suffix = "") =>
        `/v1/super-agents/schedules/${encodeURIComponent(target!)}${suffix}`;
      if (!id || id === "list") return request("/v1/super-agents/schedules");
      if (id === "get" && target) return request(path());
      if (id === "pause" && target) return request(path("/pause"), { method: "POST" });
      if (id === "resume" && target) return request(path("/resume"), { method: "POST" });
      if (id === "cancel" && target) return request(path(), { method: "DELETE" });
      if (id === "create") {
        const body = target?.startsWith("{")
          ? jsonArgument(target, "schedule")
          : {
              agentId: flags["agent-id"] ?? flags.agentId,
              request: flags.request,
              settlementAsset: (flags.asset ?? "usdg").toLowerCase(),
              budgetAmount: Number(flags.budget),
              cadence: flags.cadence,
              spendCap: Number(flags.cap ?? flags["spend-cap"]),
              ...(flags["max-runs"] ? { maxRuns: Number(flags["max-runs"]) } : {}),
              autoFund: flags["auto-fund"] === "true",
              ...(flags.start ? { startAt: flags.start } : {}),
            };
        if (!body.agentId || !body.request || !body.cadence)
          throw new Error(
            "Provide --agent-id, --request, --budget, --cadence and --cap, or a JSON schedule.",
          );
        return request("/v1/super-agents/schedules", {
          method: "POST",
          body: JSON.stringify({ source: "cli", ...body }),
        });
      }
    }
    if (action === "auctions" || action === "auction" || action === "bids") {
      const target = positional[3];
      const path = (suffix = "") =>
        `/v1/super-agents/auctions/${encodeURIComponent(target!)}${suffix}`;
      if (!id || id === "list") return request("/v1/super-agents/auctions");
      if (id === "get" && target) return request(path());
      if (id === "cancel" && target) return request(path("/cancel"), { method: "POST" });
      if (id === "award" && target) {
        if (!positional[4])
          throw new Error("Provide the bid to hire: award <auction-id> <bid-id>.");
        return request(path("/award"), {
          method: "POST",
          body: JSON.stringify({ bidId: positional[4], fund: flags.fund === "true" }),
        });
      }
      if (id === "create") {
        if (!flags.request) throw new Error("Provide --request with the job to bid on.");
        return request("/v1/super-agents/auctions", {
          method: "POST",
          body: JSON.stringify({
            request: flags.request,
            settlementAsset: (flags.asset ?? "usdg").toLowerCase(),
            ...(flags["max-budget"] ? { maxBudget: Number(flags["max-budget"]) } : {}),
            ...(flags.minutes ? { biddingMinutes: Number(flags.minutes) } : {}),
            source: "cli",
          }),
        });
      }
    }
    if (action === "triggers" || action === "trigger") {
      const target = positional[3];
      const path = (suffix = "") =>
        `/v1/super-agents/triggers/${encodeURIComponent(target!)}${suffix}`;
      if (!id || id === "list") return request("/v1/super-agents/triggers");
      if (id === "get" && target) return request(path());
      if (id === "pause" && target) return request(path("/pause"), { method: "POST" });
      if (id === "resume" && target) return request(path("/resume"), { method: "POST" });
      if (id === "cancel" && target) return request(path(), { method: "DELETE" });
      if (id === "create") {
        const agentId = flags["agent-id"] ?? flags.agentId;
        if (!agentId || !flags.repo || !flags.budget || !flags.cap)
          throw new Error("Provide --agent-id, --repo, --budget and --cap.");
        return request("/v1/super-agents/triggers", {
          method: "POST",
          body: JSON.stringify({
            agentId,
            repository: flags.repo,
            ...(flags.branch ? { branch: flags.branch } : {}),
            ...(flags.instructions ? { instructions: flags.instructions } : {}),
            settlementAsset: (flags.asset ?? "usdg").toLowerCase(),
            budgetAmount: Number(flags.budget),
            spendCap: Number(flags.cap),
            autoFund: flags["auto-fund"] === "true",
            postComment: flags["no-comment"] !== "true",
            source: "cli",
          }),
        });
      }
    }
    // Onchain triggers: a Robinhood Chain event opens a capped job for the agent.
    if (action === "onchain") {
      const target = positional[3];
      const path = (suffix = "") =>
        `/v1/super-agents/chain-triggers/${encodeURIComponent(target!)}${suffix}`;
      if (!id || id === "list") return request("/v1/super-agents/chain-triggers");
      if (id === "get" && target) return request(path());
      if (id === "pause" && target) return request(path("/pause"), { method: "POST" });
      if (id === "resume" && target) return request(path("/resume"), { method: "POST" });
      if (id === "cancel" && target) return request(path(), { method: "DELETE" });
      if (id === "create") {
        const agentId = flags["agent-id"] ?? flags.agentId;
        const contract = flags.token ?? flags.contract;
        if (!agentId || !contract || !flags.budget || !flags.cap)
          throw new Error(
            "Provide --agent-id, --token (or --contract with --event), --budget and --cap.",
          );
        const event = !flags.token && flags.event;
        if (!flags.token && !event)
          throw new Error("Use --token for transfers, or --contract with --event.");
        return request("/v1/super-agents/chain-triggers", {
          method: "POST",
          body: JSON.stringify({
            agentId,
            kind: event ? "contract_event" : "token_transfer",
            contract,
            ...(event ? { eventSignature: event } : {}),
            ...(flags.min ? { minAmount: Number(flags.min) } : {}),
            ...(flags.address ? { watchAddress: flags.address } : {}),
            ...(flags.cooldown ? { cooldownMinutes: Number(flags.cooldown) } : {}),
            ...(flags["max-per-day"] ? { maxRunsPerDay: Number(flags["max-per-day"]) } : {}),
            ...(flags.instructions ? { instructions: flags.instructions } : {}),
            settlementAsset: (flags.asset ?? "usdg").toLowerCase(),
            budgetAmount: Number(flags.budget),
            spendCap: Number(flags.cap),
            autoFund: flags["auto-fund"] === "true",
            source: "cli",
          }),
        });
      }
    }
    if (action === "squads" || action === "squad") {
      const target = positional[3];
      if (!id || id === "list") return request("/v1/super-agents/squads");
      if (id === "get" && target)
        return request(`/v1/super-agents/squads/${encodeURIComponent(target)}`);
      if (id === "cancel" && target)
        return request(`/v1/super-agents/squads/${encodeURIComponent(target)}/cancel`, {
          method: "POST",
        });
      if (id === "create") {
        let body: Json;
        if (target?.startsWith("{")) body = jsonArgument(target, "squad");
        else {
          if (!flags.request || !flags.steps)
            throw new Error(
              'Provide --request and --steps "<agent>:<budget>:<task>; ...", or a JSON squad.',
            );
          const dashboard = (await request("/v1/super-agents/dashboard")) as Json;
          body = {
            request: flags.request,
            ...(flags.name ? { name: flags.name } : {}),
            settlementAsset: (flags.asset ?? "usdg").toLowerCase(),
            autoFund: flags["auto-fund"] === "true",
            steps: squadSteps(flags.steps, (dashboard.agents as SquadAgent[] | undefined) ?? []),
          };
        }
        return request("/v1/super-agents/squads", {
          method: "POST",
          body: JSON.stringify({ source: "cli", ...body }),
        });
      }
    }
    if (action === "runtime-token" || action === "runtime-tokens") {
      if (id === "create") return request("/v1/super-agents/runtime-token", { method: "POST" });
      if (id === "list" || !id) return request("/v1/super-agents/runtime-tokens");
      if (id === "revoke" && positional[3])
        return request(`/v1/super-agents/runtime-tokens/${encodeURIComponent(positional[3])}`, {
          method: "DELETE",
        });
    }
  }
  if (resource === "calls") {
    // Pay per call: answered while you wait; refused or failed calls are refunded in full.
    if (action === "make" && id) {
      const input = flags.input?.trim();
      if (!input) throw new Error("--input is required: what the agent should answer.");
      return request("/v1/super-agents/calls", {
        method: "POST",
        body: JSON.stringify({
          agentId: id,
          input,
          settlementAsset: flags.asset ?? "usdg",
          idempotencyKey: flags.key ?? `cli-${crypto.randomUUID()}`,
        }),
      });
    }
    if (!action || action === "list")
      return request(`/v1/super-agents/calls${flags.limit ? `?limit=${flags.limit}` : ""}`);
    if (action === "get" && id) return request(`/v1/super-agents/calls/${encodeURIComponent(id)}`);
    if (action === "price" && id) {
      const price = (value: string | undefined) =>
        value === undefined ? undefined : value === "off" ? null : Number(value);
      const body = { usdg: price(flags.usdg), liege: price(flags.liege) };
      if (body.usdg === undefined && body.liege === undefined)
        throw new Error("Set --usdg and/or --liege to a price per call, or to off.");
      return request(`/v1/super-agents/enrollments/${encodeURIComponent(id)}/call-prices`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
    }
  }
  if (resource === "watchlist") {
    // A watch is a schedule with a token attached, so pausing and cancelling use the schedule routes.
    const path = (suffix = "") => `/v1/super-agents/schedules/${encodeURIComponent(id!)}${suffix}`;
    if (!action || action === "list")
      return ((await request("/v1/super-agents/watchlist")) as Json[]).map(summarizeWatch);
    if (action === "get" && id)
      return request(`/v1/super-agents/watchlist/${encodeURIComponent(id)}`);
    if (action === "pause" && id) return request(path("/pause"), { method: "POST" });
    if (action === "resume" && id) return request(path("/resume"), { method: "POST" });
    if (action === "cancel" && id) return request(path(), { method: "DELETE" });
  }
  if (resource === "jobs" && action === "list") {
    const query = new URLSearchParams();
    if (flags.status) query.set("status", flags.status);
    if (flags.asset) query.set("settlementAsset", flags.asset);
    if (flags.limit) query.set("limit", flags.limit);
    const suffix = query.toString() ? `?${query}` : "";
    return request(`/v1/jobs${suffix}`);
  }
  if (resource === "jobs" && action === "get" && id)
    return request(`/v1/jobs/${encodeURIComponent(id)}`);
  if (resource === "jobs" && action === "simulate") {
    const input = jsonArgument(id, "job");
    return request("/v1/jobs/simulate", { method: "POST", body: JSON.stringify(input) });
  }
  if (resource === "jobs" && action === "funding-quote" && id)
    return request(`/v1/jobs/${encodeURIComponent(id)}/funding-quote`, { method: "POST" });
  if (resource === "jobs" && action === "fund" && id) {
    const body = Object.fromEntries(
      Object.entries({
        quoteId: flags["quote-id"] ?? flags.quoteId,
        tokenTxHash: flags["token-tx-hash"] ?? flags.tokenTxHash,
        usdgTxHash: flags["usdg-tx-hash"] ?? flags.usdgTxHash,
        gasTxHash: flags["gas-tx-hash"] ?? flags.gasTxHash,
      }).filter(([, value]) => value),
    );
    return request(`/v1/jobs/${encodeURIComponent(id)}/fund`, {
      method: "POST",
      ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
    });
  }
  if (resource === "jobs" && action === "submit" && id) {
    const input = jsonArgument(positional[3], "deliverable");
    return request(`/v1/jobs/${encodeURIComponent(id)}/submit`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  if (resource === "jobs" && action === "evaluate" && id) {
    const input = jsonArgument(positional[3], "evaluation decision");
    return request(`/v1/jobs/${encodeURIComponent(id)}/evaluate`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }
  if (resource === "jobs" && action === "revise" && id) {
    const feedback = flags.feedback?.trim();
    if (!feedback) throw new Error("--feedback is required to request a revision.");
    return request(`/v1/jobs/${encodeURIComponent(id)}/revision`, {
      method: "POST",
      body: JSON.stringify({ feedback }),
    });
  }
  if (resource === "jobs" && action === "revision" && id)
    return request(`/v1/jobs/${encodeURIComponent(id)}/revision`);
  if (resource === "jobs" && action === "attach" && id) return attach(id, flags);
  if (resource === "jobs" && action === "attachments" && id)
    return request(`/v1/jobs/${encodeURIComponent(id)}/attachments`);
  if (resource === "jobs" && action === "attachment" && id && positional[3]) {
    const item = (await request(
      `/v1/jobs/${encodeURIComponent(id)}/attachments/${encodeURIComponent(positional[3])}`,
    )) as Json;
    if (typeof item.data !== "string") return item;
    const out = flags.out ?? basename(String(item.name));
    await Bun.write(out, Buffer.from(item.data, "base64"));
    return { ...item, data: undefined, savedTo: out };
  }
  if (resource === "jobs" && action === "detach" && id && positional[3]) {
    await request(
      `/v1/jobs/${encodeURIComponent(id)}/attachments/${encodeURIComponent(positional[3])}`,
      { method: "DELETE" },
    );
    return { removed: positional[3] };
  }
  if (resource === "jobs" && action === "receipt" && id) {
    // Fetch the receipt, then check it against the chain ourselves instead of trusting the API.
    const data = (await request(`/v1/jobs/${encodeURIComponent(id)}/receipt`)) as Parameters<
      typeof verifyReceipt
    >[0];
    return { ...data, verification: await verifyReceipt(data, flags.rpc) };
  }
  if (resource === "jobs" && action === "decline" && id) {
    const reason = flags.reason?.trim();
    if (!reason) throw new Error("--reason is required when declining a job.");
    return request(`/v1/jobs/${encodeURIComponent(id)}/decline`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  }
  if (resource === "runner" || resource === "runners") {
    if (action === "simulate" && id) {
      const input = jsonArgument(positional[3], "runner workload");
      return request(`/v1/agent-accounts/${encodeURIComponent(id)}/actions/simulate`, {
        method: "POST",
        body: JSON.stringify({ action: "runner.execute", details: runnerDetails(input) }),
      });
    }
    if (action === "authorize" && id) {
      const input = jsonArgument(positional[3], "runner workload");
      const simulationId = flags["simulation-id"] ?? flags.simulationId;
      if (!simulationId) throw new Error("--simulation-id is required for runner authorization.");
      return request(`/v1/agent-accounts/${encodeURIComponent(id)}/actions/authorize`, {
        method: "POST",
        body: JSON.stringify({
          action: "runner.execute",
          details: runnerDetails(input),
          simulationId,
        }),
      });
    }
    if (action === "execute") {
      const input = jsonArgument(id, "runner workload");
      const actionId = flags["action-id"] ?? flags.actionId;
      const simulationId = flags["simulation-id"] ?? flags.simulationId;
      const approval = actionId && simulationId ? { actionId, simulationId } : {};
      return request("/v1/runners", {
        method: "POST",
        body: JSON.stringify({ ...input, ...approval }),
      });
    }
    if (action === "list") {
      const agentId = flags["agent-id"] ?? flags.agentId;
      return request(`/v1/runners${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`);
    }
    if (action === "status" && id) return request(`/v1/runners/${encodeURIComponent(id)}`);
    if (action === "artifact" && id && positional[3])
      return request(
        `/v1/runners/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(positional[3])}`,
      );
  }
  if (resource === "invoices" && action === "list") return request("/v1/invoices");
  if (resource === "invoices" && action === "issue" && positional[2]) {
    let invoice: unknown;
    try {
      invoice = JSON.parse(positional[2]);
    } catch {
      throw new Error("The invoice argument must be valid JSON.");
    }
    return request("/v1/invoices", { method: "POST", body: JSON.stringify(invoice) });
  }
  if (resource === "invoices" && ["pay", "refund", "cancel"].includes(action ?? "") && id)
    return request(`/v1/invoices/${id}/${action}`, { method: "POST" });

  if (resource === "account" || resource === "accounts") {
    if (action === "list") {
      return request("/v1/agent-accounts");
    }
    if ((action === "status" || action === "get") && id) {
      return request(`/v1/agent-accounts/${id}`);
    }
    if (action === "pause" && id) {
      const reason =
        flags.reason ??
        (positional[3] && !positional[3].startsWith("--") ? positional[3] : undefined);
      return request(`/v1/agent-accounts/${id}/control`, {
        method: "POST",
        body: JSON.stringify({ command: "pause", ...(reason ? { reason } : {}) }),
      });
    }
    if (action === "resume" && id) {
      return request(`/v1/agent-accounts/${id}/control`, {
        method: "POST",
        body: JSON.stringify({ command: "resume" }),
      });
    }
    if (action === "kill" && id) {
      const reason =
        flags.reason ??
        (positional[3] && !positional[3].startsWith("--") ? positional[3] : undefined);
      return request(`/v1/agent-accounts/${id}/control`, {
        method: "POST",
        body: JSON.stringify({ command: "kill", ...(reason ? { reason } : {}) }),
      });
    }
    if ((action === "mandates" || action === "mandate") && id) {
      const mandateId =
        positional[3] && !positional[3].startsWith("--") ? positional[3] : undefined;
      const isAp2 = flags.format === "ap2" || flags.ap2 === "true";
      if (mandateId) {
        const path = isAp2
          ? `/v1/agent-accounts/${id}/mandates/${mandateId}/ap2`
          : `/v1/agent-accounts/${id}/mandates/${mandateId}`;
        return request(path);
      }
      return request(`/v1/agent-accounts/${id}/mandates`);
    }
    if (action === "policy") {
      if (id === "set" && positional[3] && positional[4]) {
        const agentId = positional[3];
        let policy: unknown;
        try {
          policy = JSON.parse(positional[4]);
        } catch {
          throw new Error("The policy argument must be valid JSON.");
        }
        return request(`/v1/agent-accounts/${agentId}/policy`, {
          method: "PUT",
          body: JSON.stringify(policy),
        });
      }
      if (id && id !== "set") {
        if (positional[3] === "set" && positional[4]) {
          let policy: unknown;
          try {
            policy = JSON.parse(positional[4]);
          } catch {
            throw new Error("The policy argument must be valid JSON.");
          }
          return request(`/v1/agent-accounts/${id}/policy`, {
            method: "PUT",
            body: JSON.stringify(policy),
          });
        }
        const account = (await request(`/v1/agent-accounts/${id}`)) as Json;
        return account?.policy ?? account;
      }
    }
  }

  if (resource === "services" || resource === "service") {
    if (action === "list") {
      const query = new URLSearchParams();
      const agentId = flags["agent-id"] ?? flags.agentId ?? flags.agent;
      const serviceType = flags["service-type"] ?? flags.serviceType ?? flags.type;
      const limit = flags.limit;
      if (agentId) query.set("agentId", agentId);
      if (serviceType) query.set("type", serviceType);
      if (limit) query.set("limit", limit);
      const queryString = query.toString();
      const path = queryString ? `/v1/services?${queryString}` : "/v1/services";
      return request(path, {}, false);
    }
    if (action === "get" && id && positional[3]) {
      const slug = positional[3];
      return request(`/v1/services/${id}/${slug}`, {}, false);
    }
    if (action === "create") {
      let servicePayload: unknown;
      const rawJson = positional[2];
      if (
        rawJson &&
        (rawJson.startsWith("{") || (!rawJson.startsWith("-") && rawJson.includes(":")))
      ) {
        try {
          servicePayload = JSON.parse(rawJson);
        } catch {
          throw new Error("The service argument must be valid JSON.");
        }
      } else {
        const agentId = flags["agent-id"] ?? flags.agentId ?? flags.agent;
        const slug = flags.slug;
        const name = flags.name;
        const description = flags.description ?? flags.desc;
        const serviceType = flags["service-type"] ?? flags.serviceType ?? flags.type;
        const priceRaw = flags.price ?? flags["price-usd"] ?? flags.priceUsd;
        const slaRaw = flags.sla ?? flags["sla-minutes"] ?? flags.slaMinutes;

        if (!agentId || !slug || !name || !description || !serviceType || !priceRaw || !slaRaw) {
          throw new Error(
            "Missing required service parameters. Provide JSON or flags: --agent-id, --slug, --name, --description, --service-type, --price, --sla",
          );
        }

        let requirementsSchema: Record<string, unknown> = {};
        const reqStr = flags.requirements ?? flags["requirements-schema"];
        if (reqStr) {
          try {
            requirementsSchema = JSON.parse(reqStr);
          } catch {
            throw new Error("Requirements schema must be valid JSON.");
          }
        }

        let deliverableSchema: Record<string, unknown> = {};
        const delStr = flags.deliverables ?? flags["deliverable-schema"];
        if (delStr) {
          try {
            deliverableSchema = JSON.parse(delStr);
          } catch {
            throw new Error("Deliverable schema must be valid JSON.");
          }
        }

        servicePayload = {
          agentId,
          slug,
          name,
          description,
          serviceType,
          executionMode: flags["execution-mode"] ?? flags.executionMode ?? flags.mode ?? "manual",
          priceUsd: Number(priceRaw),
          slaMinutes: Number(slaRaw),
          requirementsSchema,
          deliverableSchema,
        };
      }
      return request("/v1/services", {
        method: "POST",
        body: JSON.stringify(servicePayload),
      });
    }
  }

  if (resource === "mcp" && action === "connections") return request("/v1/mcp/connections");
  if (resource === "mcp" && action === "revoke" && id) {
    await request(`/v1/mcp/connections/${id}`, { method: "DELETE" });
    return { revoked: id };
  }
  // A hiring key lets your own AI agent propose Super Agent work over MCP; you still approve it.
  if (resource === "hire-keys" && action === "list") return request("/v1/mcp/hire-keys");
  if (resource === "hire-keys" && action === "revoke" && id) {
    await request(`/v1/mcp/hire-keys/${id}`, { method: "DELETE" });
    return { revoked: id };
  }
  if (resource === "hire-keys" && action === "create") {
    if (!id || !flags["max-per-hire"] || !flags.daily)
      throw new Error("Provide a name, --max-per-hire and --daily (USDG).");
    return request("/v1/mcp/hire-keys", {
      method: "POST",
      body: JSON.stringify({
        name: id,
        maxBudgetPerHire: Number(flags["max-per-hire"]),
        dailyBudget: Number(flags.daily),
        ...(flags.days ? { expiresInDays: Number(flags.days) } : {}),
      }),
    });
  }
  if (resource === "policy" && action === "get" && id) return request(`/v1/mcp/policies/${id}`);
  if (resource === "policy" && action === "set" && id && positional[3]) {
    let policy: unknown;
    try {
      policy = JSON.parse(positional[3]);
    } catch {
      throw new Error("The policy argument must be valid JSON.");
    }
    return request(`/v1/mcp/policies/${id}`, { method: "PUT", body: JSON.stringify(policy) });
  }
  if (resource === "proposals" && action === "list") {
    const status = flags.status;
    return request(`/v1/mcp/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }
  if (resource === "proposals" && action === "get" && id)
    return request(`/v1/mcp/proposals/${encodeURIComponent(id)}`);
  if (resource === "proposals" && action === "wait" && id) {
    const timeoutMs = Number(flags["timeout-ms"] ?? flags.timeoutMs ?? 30_000);
    const pollMs = Number(flags["poll-ms"] ?? flags.pollMs ?? 1_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000)
      throw new Error("--timeout-ms must be an integer between 500 and 120000.");
    if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 5_000)
      throw new Error("--poll-ms must be an integer between 250 and 5000.");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const proposal = (await request(`/v1/mcp/proposals/${encodeURIComponent(id)}`)) as Json;
      if (proposal.effective_status !== "pending" || Date.now() >= deadline)
        return { ...proposal, timedOut: proposal.effective_status === "pending" };
      await wait(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }
  if (resource === "proposals" && (action === "approve" || action === "reject") && id)
    return request(`/v1/mcp/proposals/${id}/${action === "approve" ? "approved" : "rejected"}`, {
      method: "POST",
    });

  usage();
}

export const isChatInvocation = (args: string[]) =>
  args.includes("--spg") ||
  ((args[0] === "superagents" || args[0] === "super-agents") && args[1] === "chat");

async function main(args: string[]) {
  if (isChatInvocation(args)) {
    const { startChat } = await import("./chat.js");
    return startChat();
  }
  const result = await execute(args);
  if (result !== undefined) {
    print(result);
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
