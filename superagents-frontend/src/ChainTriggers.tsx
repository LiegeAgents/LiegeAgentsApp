import React, { useEffect, useState } from "react";
import { ExternalLink, Pause, Play, Radio, X } from "lucide-react";

type CatalogAgent = {
  id: string;
  name: string;
  price_usd?: string | number;
  settlement_assets?: string[];
  service_settlement_assets?: string[];
};

type Run = {
  id: string;
  tx_hash: string;
  summary: string;
  outcome: "funded" | "awaiting_funding" | "skipped" | "failed";
  detail: string | null;
  job_status: string | null;
  job_deadline_at: string | null;
};

type ChainTrigger = {
  id: string;
  agent_name: string;
  kind: "token_transfer" | "contract_event";
  contract_address: string;
  event_signature: string;
  token_symbol: string | null;
  min_amount: string | null;
  watch_address: string | null;
  settlement_asset: "usdg" | "liege";
  budget_amount: string;
  spend_cap: string;
  committed_amount: string;
  runs_count: number;
  skipped_count: number;
  cooldown_minutes: number;
  max_runs_per_day: number;
  auto_fund: boolean;
  status: "active" | "paused" | "cancelled" | "completed";
  status_reason: string | null;
  runs: Run[];
};

const EXPLORER = "https://robinhoodchain.blockscout.com";
const amount = (value: string | number) => Number(value).toLocaleString();
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const cooldowns = [
  [15, "15 minutes"],
  [60, "1 hour"],
  [360, "6 hours"],
  [1440, "1 day"],
] as const;

function runLabel(run: Run) {
  if (run.job_status === "submitted" || run.job_status === "completed") return "Delivered";
  if (run.outcome === "funded" || run.job_status === "funded") return "Agent working";
  if (run.outcome === "awaiting_funding" && run.job_status === "open")
    return run.job_deadline_at && new Date(run.job_deadline_at) > new Date()
      ? `Fund by ${new Date(run.job_deadline_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Funding window passed";
  if (run.outcome === "failed") return "Failed";
  return run.job_status ? run.job_status : "Skipped";
}

function describe(item: ChainTrigger) {
  if (item.kind === "contract_event")
    return `${item.event_signature.split("(")[0]} on ${short(item.contract_address)}`;
  const token = item.token_symbol ?? short(item.contract_address);
  return [
    `${token} transfers`,
    item.min_amount ? `of ${amount(item.min_amount)}+` : "",
    item.watch_address ? `to or from ${short(item.watch_address)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function ChainTriggers({
  api,
  token,
  agents,
  notify,
}: {
  api: string;
  token: string;
  agents: CatalogAgent[];
  notify: (notice: { title: string; body: string }) => void;
}) {
  const [triggers, setTriggers] = useState<ChainTrigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [kind, setKind] = useState<ChainTrigger["kind"]>("token_transfer");
  const [asset, setAsset] = useState<"usdg" | "liege">("usdg");
  const agent = agents.find((item) => item.id === agentId);
  const assets = (["usdg", "liege"] as const).filter((item) =>
    (agent?.service_settlement_assets ?? agent?.settlement_assets ?? ["usdg"]).includes(item),
  );

  useEffect(() => {
    if (agent && !assets.includes(asset)) setAsset(assets[0] ?? "usdg");
  }, [agentId]);
  // Anna writes research briefs, a natural reader of onchain events.
  useEffect(() => {
    if (!agentId) {
      const anna = agents.find((item) => item.name.toLowerCase().startsWith("anna"));
      if (anna) setAgentId(anna.id);
    }
  }, [agents]);

  async function call(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1/super-agents/chain-triggers${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(result.error?.message || "The update could not be completed.");
    return result.data;
  }

  async function load() {
    setTriggers(await call(""));
  }

  useEffect(() => {
    void load()
      .catch((error) => notify({ title: "Could not load onchain triggers", body: error.message }))
      .finally(() => setLoading(false));
    const timer = setInterval(() => void load().catch(() => undefined), 20_000);
    return () => clearInterval(timer);
  }, [api, token]);

  async function act(title: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await load();
    } catch (error) {
      notify({ title, body: error instanceof Error ? error.message : "Try again." });
    } finally {
      setBusy(false);
    }
  }

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    void act("Trigger not created", async () => {
      await call("", "POST", {
        agentId,
        kind,
        contract: text("contract"),
        ...(kind === "token_transfer"
          ? {
              ...(text("minAmount") ? { minAmount: Number(text("minAmount")) } : {}),
              ...(text("watchAddress") ? { watchAddress: text("watchAddress") } : {}),
            }
          : { eventSignature: text("eventSignature") }),
        ...(text("instructions") ? { instructions: text("instructions") } : {}),
        settlementAsset: asset,
        budgetAmount: Number(form.get("budget")),
        spendCap: Number(form.get("cap")),
        cooldownMinutes: Number(form.get("cooldown")),
        maxRunsPerDay: Number(form.get("maxPerDay")),
        autoFund: form.get("autoFund") === "on",
        source: "dashboard",
      });
      element.reset();
      notify({
        title: "Watching Robinhood Chain",
        body: "New blocks are checked about once a minute. Events from before now are not counted.",
      });
    });
  }

  return (
    <div className="recurring-grid">
      <section className="panel enrollment-panel enrollment-editor">
        <div className="panel-heading enrollment-heading">
          <h2>Act on an onchain event</h2>
          <span className="enrollment-kicker">ROBINHOOD CHAIN · CAPPED SPEND</span>
        </div>
        <form className="settings-content enrollment-content recurring-form" onSubmit={create}>
          <p>
            When a matching event lands on Robinhood Chain, Liege opens a job for your agent with
            the transaction attached. Each job is escrowed on its own and the total never exceeds
            your cap. Unless it is funded automatically, you fund each job before its deadline.
          </p>
          <label className="enrollment-field" htmlFor="chain-agent">
            Agent
          </label>
          <select
            id="chain-agent"
            required
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">Choose a Super Agent</option>
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="recurring-row">
            <label>
              <span className="enrollment-field">Watch for</span>
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as ChainTrigger["kind"])}
              >
                <option value="token_transfer">Token transfers</option>
                <option value="contract_event">Any contract event</option>
              </select>
            </label>
            <label>
              <span className="enrollment-field">
                {kind === "token_transfer" ? "Token contract" : "Contract"}
              </span>
              <input className="trigger-input" name="contract" required placeholder="0x…" />
            </label>
          </div>
          {kind === "token_transfer" ? (
            <div className="recurring-row">
              <label>
                <span className="enrollment-field">At least (tokens, optional)</span>
                <input name="minAmount" type="number" min="0" step="any" placeholder="1000000" />
              </label>
              <label>
                <span className="enrollment-field">To or from (optional)</span>
                <input className="trigger-input" name="watchAddress" placeholder="0x…" />
              </label>
            </div>
          ) : (
            <label>
              <span className="enrollment-field">Event</span>
              <input
                className="trigger-input"
                name="eventSignature"
                required
                placeholder="OwnershipTransferred(address indexed previousOwner, address indexed newOwner)"
              />
            </label>
          )}
          <label className="enrollment-field" htmlFor="chain-instructions">
            What the agent should do (optional)
          </label>
          <textarea
            id="chain-instructions"
            name="instructions"
            maxLength={2000}
            rows={2}
            placeholder="Explain what this event means for holders and what to watch next."
          />
          <div className="recurring-row">
            <label>
              <span className="enrollment-field">Budget per job</span>
              <input
                name="budget"
                type="number"
                min="0.01"
                step="0.01"
                required
                defaultValue={agent?.price_usd ? Number(agent.price_usd) : undefined}
                key={agentId}
              />
            </label>
            <label>
              <span className="enrollment-field">Total spending cap</span>
              <input name="cap" type="number" min="0.01" step="0.01" required />
            </label>
            <label>
              <span className="enrollment-field">Pay in</span>
              <select
                value={asset}
                onChange={(event) => setAsset(event.target.value as "usdg" | "liege")}
              >
                {assets.map((item) => (
                  <option key={item} value={item}>
                    {item.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="recurring-row">
            <label>
              <span className="enrollment-field">At most one job every</span>
              <select name="cooldown" defaultValue={60}>
                {cooldowns.map(([minutes, label]) => (
                  <option key={minutes} value={minutes}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="enrollment-field">At most per day</span>
              <input name="maxPerDay" type="number" min="1" max="48" defaultValue={4} required />
            </label>
          </div>
          <label className="recurring-toggle">
            <input name="autoFund" type="checkbox" />
            <span>
              <strong>Fund jobs automatically from my Liege balance</strong>
              <small>
                Only for jobs held in Liege escrow. Jobs that need an on-chain deposit always wait
                for your wallet, and you are notified when one opens.
              </small>
            </span>
          </label>
          <button className="button" type="submit" disabled={busy || !agentId}>
            <Radio size={15} /> Approve and watch
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Your onchain triggers</h2>
          <span className="preview-label">
            {triggers.filter((item) => item.status === "active").length} active
          </span>
        </div>
        {loading ? (
          <p className="muted recurring-empty">Loading…</p>
        ) : !triggers.length ? (
          <div className="empty">
            <Radio size={28} />
            <h3>Nothing watched yet.</h3>
            <p>Something happens onchain, and your agent is already on it.</p>
          </div>
        ) : (
          triggers.map((item) => {
            const unit = item.settlement_asset.toUpperCase();
            const used = Math.min(
              100,
              (Number(item.committed_amount) / Number(item.spend_cap)) * 100,
            );
            const open = item.status === "active" || item.status === "paused";
            return (
              <article className="recurring-item trigger-item chain-trigger-item" key={item.id}>
                <header>
                  <div>
                    <strong>{describe(item)}</strong>
                    <small>
                      {item.agent_name} · {amount(item.budget_amount)} {unit} per job · at most{" "}
                      {item.max_runs_per_day}/day
                      {item.auto_fund ? " · auto-funded" : ""}
                    </small>
                  </div>
                  <span className={`status status-${item.status}`}>{item.status}</span>
                </header>
                <div className="recurring-meter" aria-label={`${used.toFixed(0)}% of cap used`}>
                  <span style={{ width: `${used}%` }} />
                </div>
                <small className="muted">
                  {amount(item.committed_amount)} of {amount(item.spend_cap)} {unit} committed ·{" "}
                  {item.runs_count} job{item.runs_count === 1 ? "" : "s"}
                  {item.skipped_count
                    ? ` · ${amount(item.skipped_count)} more events held back by your limits`
                    : ""}
                </small>
                {item.status_reason && <small className="muted">{item.status_reason}</small>}
                {item.runs.slice(0, 3).map((run) => (
                  <small key={run.id} className={`recurring-run recurring-run-${run.outcome}`}>
                    {run.summary}: {runLabel(run)}
                    {run.detail && run.outcome === "failed" ? ` — ${run.detail}` : ""}{" "}
                    <a
                      className="chain-tx-link"
                      href={`${EXPLORER}/tx/${run.tx_hash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Transaction <ExternalLink size={11} />
                    </a>
                  </small>
                ))}
                {open && (
                  <div className="recurring-actions">
                    {item.status === "active" ? (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act("Could not pause", () => call(`/${item.id}/pause`, "POST"))
                        }
                      >
                        <Pause size={14} /> Pause
                      </button>
                    ) : (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act("Could not resume", () => call(`/${item.id}/resume`, "POST"))
                        }
                      >
                        <Play size={14} /> Resume
                      </button>
                    )}
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        if (confirm("Stop watching? Jobs already opened are kept."))
                          void act("Could not cancel", () => call(`/${item.id}`, "DELETE"));
                      }}
                    >
                      <X size={14} /> Stop watching
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
