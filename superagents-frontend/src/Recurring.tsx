import React, { useEffect, useState } from "react";
import { Pause, Play, Repeat, X } from "lucide-react";

type CatalogAgent = {
  id: string;
  name: string;
  price_usd?: string | number;
  sla_minutes?: number;
  settlement_assets?: string[];
  service_settlement_assets?: string[];
};

type Run = {
  id: string;
  slot: string;
  outcome: "funded" | "awaiting_funding" | "skipped" | "failed";
  detail: string | null;
  job_id: string | null;
  job_status: string | null;
};

type Schedule = {
  id: string;
  agent_name: string;
  request: string;
  settlement_asset: "usdg" | "liege";
  budget_amount: string;
  cadence: "daily" | "weekly" | "monthly";
  next_run_at: string;
  spend_cap: string;
  committed_amount: string;
  max_runs: number | null;
  runs_count: number;
  auto_fund: boolean;
  status: "active" | "paused" | "cancelled" | "completed";
  status_reason: string | null;
  runs: Run[];
};

const outcomeLabel: Record<Run["outcome"], string> = {
  funded: "Funded automatically",
  awaiting_funding: "Waiting for your funding",
  skipped: "Skipped",
  failed: "Failed",
};

const amount = (value: string | number) => Number(value).toLocaleString();

export function Recurring({
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
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [asset, setAsset] = useState<"usdg" | "liege">("usdg");
  const agent = agents.find((item) => item.id === agentId);
  const assets = (["usdg", "liege"] as const).filter((item) =>
    (agent?.service_settlement_assets ?? agent?.settlement_assets ?? ["usdg"]).includes(item),
  );

  useEffect(() => {
    if (agent && !assets.includes(asset)) setAsset(assets[0] ?? "usdg");
  }, [agentId]);

  async function call(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1/super-agents/schedules${path}`, {
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
    setSchedules(await call(""));
  }

  useEffect(() => {
    void load()
      .catch((error) => notify({ title: "Could not load recurring jobs", body: error.message }))
      .finally(() => setLoading(false));
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
    const form = new FormData(event.currentTarget);
    const element = event.currentTarget;
    const maxRuns = Number(form.get("maxRuns"));
    void act("Recurring job not created", async () => {
      await call("", "POST", {
        agentId,
        request: String(form.get("request") ?? ""),
        settlementAsset: asset,
        budgetAmount: Number(form.get("budget")),
        cadence: String(form.get("cadence")),
        spendCap: Number(form.get("cap")),
        ...(maxRuns > 0 ? { maxRuns } : {}),
        autoFund: form.get("autoFund") === "on",
        source: "dashboard",
      });
      element.reset();
      setAgentId("");
      notify({
        title: "Recurring job created",
        body: "The first run opens shortly. Each run appears in Requests and Activity.",
      });
    });
  }

  const live = schedules.filter((item) => item.status === "active" || item.status === "paused");
  const ended = schedules.filter((item) => item.status !== "active" && item.status !== "paused");

  return (
    <div className="recurring-grid">
      <section className="panel enrollment-panel enrollment-editor">
        <div className="panel-heading enrollment-heading">
          <h2>New recurring job</h2>
          <span className="enrollment-kicker">ONE APPROVAL · CAPPED SPEND</span>
        </div>
        <form className="settings-content enrollment-content recurring-form" onSubmit={create}>
          <p>
            Approve a job once and it repeats on schedule. Every run opens a job like an approved
            proposal, and the total never exceeds your cap. Pause or cancel at any time.
          </p>
          <label className="enrollment-field" htmlFor="recurring-agent">
            Agent
          </label>
          <select
            id="recurring-agent"
            required
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
          >
            <option value="">Choose a Super Agent</option>
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.price_usd ? ` · from ${amount(item.price_usd)} USD` : ""}
              </option>
            ))}
          </select>
          <label className="enrollment-field" htmlFor="recurring-request">
            What should they do each time?
          </label>
          <textarea
            id="recurring-request"
            name="request"
            required
            maxLength={10000}
            rows={3}
            placeholder="A cited brief on what our top three competitors shipped this week."
          />
          <div className="recurring-row">
            <label>
              <span className="enrollment-field">How often</span>
              <select name="cadence" defaultValue="weekly">
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label>
              <span className="enrollment-field">Budget per run</span>
              <input name="budget" type="number" min="0.01" step="0.01" required />
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
              <span className="enrollment-field">Total spending cap</span>
              <input name="cap" type="number" min="0.01" step="0.01" required />
            </label>
            <label>
              <span className="enrollment-field">Stop after (runs, optional)</span>
              <input name="maxRuns" type="number" min="1" max="1000" step="1" />
            </label>
          </div>
          <label className="recurring-toggle">
            <input name="autoFund" type="checkbox" />
            <span>
              <strong>Fund runs automatically from my Liege balance</strong>
              <small>
                Only for jobs held in Liege escrow. Jobs that need an on-chain deposit always wait
                for your wallet.
              </small>
            </span>
          </label>
          <button className="button" type="submit" disabled={busy || !agentId}>
            <Repeat size={15} /> Approve recurring job
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Your recurring jobs</h2>
          <span className="preview-label">{live.length} running</span>
        </div>
        {loading ? (
          <p className="muted recurring-empty">Loading…</p>
        ) : !schedules.length ? (
          <div className="empty">
            <Repeat size={28} />
            <h3>Nothing repeating yet.</h3>
            <p>Set up a weekly brief, a daily digest, or a monthly review.</p>
          </div>
        ) : (
          [...live, ...ended].map((item) => {
            const unit = item.settlement_asset.toUpperCase();
            const used = Math.min(
              100,
              (Number(item.committed_amount) / Number(item.spend_cap)) * 100,
            );
            const last = item.runs[0];
            return (
              <article className="recurring-item" key={item.id}>
                <header>
                  <div>
                    <strong>{item.agent_name}</strong>
                    <small>
                      {item.cadence} · {amount(item.budget_amount)} {unit} per run
                      {item.auto_fund ? " · auto-funded" : ""}
                    </small>
                  </div>
                  <span className={`status status-${item.status}`}>{item.status}</span>
                </header>
                <p>{item.request}</p>
                <div className="recurring-meter" aria-label={`${used.toFixed(0)}% of cap used`}>
                  <span style={{ width: `${used}%` }} />
                </div>
                <small className="muted">
                  {amount(item.committed_amount)} of {amount(item.spend_cap)} {unit} committed ·{" "}
                  {item.runs_count} run{item.runs_count === 1 ? "" : "s"}
                  {item.max_runs ? ` of ${item.max_runs}` : ""}
                  {item.status === "active"
                    ? ` · next ${new Date(item.next_run_at).toLocaleString()}`
                    : ""}
                </small>
                {item.status_reason && <small className="muted">{item.status_reason}</small>}
                {last && (
                  <small className={`recurring-run recurring-run-${last.outcome}`}>
                    Last run: {outcomeLabel[last.outcome]}
                    {last.detail ? ` — ${last.detail}` : ""}
                  </small>
                )}
                {(item.status === "active" || item.status === "paused") && (
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
                        if (confirm("Cancel this recurring job? Jobs already opened are kept."))
                          void act("Could not cancel", () => call(`/${item.id}`, "DELETE"));
                      }}
                    >
                      <X size={14} /> Cancel
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
