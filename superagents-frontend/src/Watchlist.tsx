import React, { useEffect, useState } from "react";
import { Check, Eye, Pause, Play, X } from "lucide-react";

type CatalogAgent = {
  id: string;
  slug?: string;
  name: string;
  price_usd?: string | number;
  settlement_assets?: string[];
  service_settlement_assets?: string[];
};

type Change = {
  signal: "honeypot" | "ownership" | "liquidity" | "tax";
  label: string;
  detail: string;
};

type Run = {
  id: string;
  slot: string;
  outcome: "funded" | "awaiting_funding" | "skipped" | "failed";
  detail: string | null;
  created_at: string;
  job_id: string | null;
  job_status: string | null;
  verdict: string | null;
  risk_score: number | null;
  baseline: boolean | null;
  changes: Change[];
  checked_at: string | null;
};

type Watch = {
  id: string;
  watch_token: string;
  watch_chain: string;
  chain_name: string;
  agent_name: string;
  settlement_asset: "usdg" | "liege";
  budget_amount: string;
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

const chains = [
  { id: "robinhood", name: "Robinhood Chain" },
  { id: "ethereum", name: "Ethereum" },
  { id: "base", name: "Base" },
  { id: "arbitrum", name: "Arbitrum" },
  { id: "bsc", name: "BNB Chain" },
];

const outcomeLabel: Record<Run["outcome"], string> = {
  funded: "Check in progress",
  awaiting_funding: "Waiting for your funding",
  skipped: "Skipped",
  failed: "Failed",
};

const amount = (value: string | number) => Number(value).toLocaleString();
const shortToken = (token: string) => `${token.slice(0, 6)}…${token.slice(-4)}`;
const when = (run: Run) => new Date(run.checked_at ?? run.created_at).toLocaleString();
const delivered = (run: Run) => run.verdict !== null;
// Delivered, waiting on your review, and nothing got worse since the previous check.
const isClean = (run: Run) =>
  Boolean(run.job_id) && run.job_status === "submitted" && delivered(run) && !run.changes.length;

function Verdict({ run }: { run: Run }) {
  return (
    <>
      {run.verdict}
      {run.risk_score !== null ? ` · risk ${run.risk_score}/100` : ""}
      {run.baseline && <span className="watch-tag">Baseline</span>}
    </>
  );
}

export function Watchlist({
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
  const [watches, setWatches] = useState<Watch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [asset, setAsset] = useState<"usdg" | "liege">("usdg");
  // The rug-check agent, if it is in the catalog, for its listed price and pay-in assets.
  const checker = agents.find((item) => /constantine|rug/i.test(`${item.slug ?? ""} ${item.name}`));
  const assets = (["usdg", "liege"] as const).filter((item) =>
    (checker?.service_settlement_assets ?? checker?.settlement_assets ?? ["usdg"]).includes(item),
  );
  const listedPrice =
    asset === "usdg" && Number(checker?.price_usd) > 0 ? amount(checker!.price_usd!) : undefined;

  useEffect(() => {
    if (!assets.includes(asset)) setAsset(assets[0] ?? "usdg");
  }, [checker?.id]);

  async function call(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1${path}`, {
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
    setWatches(await call("/super-agents/watchlist"));
  }

  useEffect(() => {
    void load()
      .catch((error) => notify({ title: "Could not load your watchlist", body: error.message }))
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
    const budget = Number(form.get("budget"));
    const cap = Number(form.get("cap"));
    void act("Token not added", async () => {
      await call("/super-agents/watchlist", "POST", {
        token: String(form.get("token") ?? "").trim(),
        chain: String(form.get("chain")),
        settlementAsset: asset,
        ...(budget > 0 ? { budgetAmount: budget } : {}),
        ...(cap > 0 ? { spendCap: cap } : {}),
        autoFund: form.get("autoFund") === "on",
        source: "dashboard",
      });
      element.reset();
      notify({
        title: "Token added to your watchlist",
        body: "The first check opens shortly and becomes the baseline. Each check appears in Requests and Activity.",
      });
    });
  }

  // One ordinary client settlement per clean run, in order. Alerts stay for your review.
  function acceptClean(item: Watch) {
    void act("Could not accept clean runs", async () => {
      const detail: Watch = await call(`/super-agents/watchlist/${item.id}`);
      const clean = detail.runs.filter(isClean);
      let accepted = 0;
      let firstError = "";
      for (const run of clean) {
        try {
          await call(`/jobs/${run.job_id}/evaluate`, "POST", {
            outcome: "accepted",
            rationale: run.baseline
              ? "Baseline watchlist check delivered."
              : "No worsened signals since the last watchlist check.",
          });
          accepted += 1;
        } catch (error) {
          firstError ||= error instanceof Error ? error.message : "Try again.";
        }
      }
      const failed = clean.length - accepted;
      notify(
        failed
          ? {
              title: "Some runs were not accepted",
              body: `Accepted ${accepted} of ${clean.length}. ${failed} could not be accepted: ${firstError}`,
            }
          : {
              title: "Clean runs accepted",
              body: `Accepted ${accepted} run${accepted === 1 ? "" : "s"}. Runs with alerts are left for your review.`,
            },
      );
    });
  }

  const live = watches.filter((item) => item.status === "active" || item.status === "paused");
  const ended = watches.filter((item) => item.status !== "active" && item.status !== "paused");

  return (
    <div className="recurring-grid">
      <section className="panel enrollment-panel enrollment-editor">
        <div className="panel-heading enrollment-heading">
          <h2>Watch a token</h2>
          <span className="enrollment-kicker">RE-CHECKED DAILY · CAPPED SPEND</span>
        </div>
        <form className="settings-content enrollment-content recurring-form" onSubmit={create}>
          <p>
            Constantine re-checks the token every day. The first check is the baseline. After that,
            you are alerted only if ownership, liquidity, a tax, or a honeypot flag gets worse. Each
            check is a paid job, and the total never exceeds your cap. Pause or cancel at any time.
          </p>
          <label className="enrollment-field" htmlFor="watch-token">
            Token address
          </label>
          <input
            id="watch-token"
            className="watch-input"
            name="token"
            required
            autoComplete="off"
            spellCheck={false}
            pattern="\s*0x[0-9a-fA-F]{40}\s*"
            title="The token's contract address: 0x and 40 characters."
            placeholder="0x…"
          />
          <div className="recurring-row">
            <label>
              <span className="enrollment-field">Chain</span>
              <select name="chain" defaultValue="robinhood">
                {chains.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="enrollment-field">Budget per check</span>
              <input
                name="budget"
                type="number"
                min="0.01"
                step="0.01"
                required={asset !== "usdg"}
                placeholder={listedPrice}
              />
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
          <label className="enrollment-field" htmlFor="watch-cap">
            Total spending cap (optional)
          </label>
          <input
            id="watch-cap"
            name="cap"
            type="number"
            min="0.01"
            step="0.01"
            placeholder="Defaults to 30 checks"
          />
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
          <button className="button" type="submit" disabled={busy}>
            <Eye size={15} /> Watch token
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Your watchlist</h2>
          <span className="preview-label">{live.length} watching</span>
        </div>
        {loading ? (
          <p className="muted recurring-empty">Loading…</p>
        ) : !watches.length ? (
          <div className="empty">
            <Eye size={28} />
            <h3>No tokens watched yet.</h3>
            <p>Save a token and Constantine re-checks it daily.</p>
          </div>
        ) : (
          [...live, ...ended].map((item) => {
            const unit = item.settlement_asset.toUpperCase();
            const used = Math.min(
              100,
              (Number(item.committed_amount) / Number(item.spend_cap)) * 100,
            );
            const latest = item.runs.find(delivered);
            const alert = item.runs.find((run) => run.changes.length > 0);
            const clean = item.runs.filter(isClean).length;
            return (
              <article className="recurring-item" key={item.id}>
                <header>
                  <div>
                    <strong title={item.watch_token}>
                      {shortToken(item.watch_token)} · {item.chain_name}
                    </strong>
                    <small>
                      {item.agent_name} · daily · {amount(item.budget_amount)} {unit} per check
                      {item.auto_fund ? " · auto-funded" : ""}
                    </small>
                  </div>
                  <span className={`status status-${item.status}`}>{item.status}</span>
                </header>
                <p>
                  {latest ? (
                    <>
                      Latest check: <Verdict run={latest} />
                    </>
                  ) : (
                    "No check delivered yet."
                  )}
                </p>
                {alert && (
                  <div className="watch-alert">
                    <strong>Last alert · {when(alert)}</strong>
                    <ul>
                      {alert.changes.map((change) => (
                        <li key={change.signal}>
                          <b>{change.label}:</b> {change.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="recurring-meter" aria-label={`${used.toFixed(0)}% of cap used`}>
                  <span style={{ width: `${used}%` }} />
                </div>
                <small className="muted">
                  {amount(item.committed_amount)} of {amount(item.spend_cap)} {unit} committed ·{" "}
                  {item.runs_count} check{item.runs_count === 1 ? "" : "s"}
                  {item.max_runs ? ` of ${item.max_runs}` : ""}
                  {item.status === "active"
                    ? ` · next check ${new Date(item.next_run_at).toLocaleString()}`
                    : ""}
                </small>
                {item.status_reason && <small className="muted">{item.status_reason}</small>}
                {item.runs.length > 0 && (
                  <ul className="watch-runs" aria-label="Recent checks">
                    {item.runs.map((run) => (
                      <li
                        key={run.id}
                        className={`watch-run ${run.changes.length ? "watch-run-alert" : ""}`}
                      >
                        <span className="watch-run-time">{when(run)}</span>
                        <span>
                          {delivered(run) ? (
                            <>
                              <Verdict run={run} />
                              {run.changes.length
                                ? ` · ${run.changes.map((change) => change.label).join(", ")}`
                                : run.baseline
                                  ? ""
                                  : " · no changes"}
                              {run.job_status === "submitted" ? " · awaiting your review" : ""}
                              {run.job_status === "completed" ? " · accepted" : ""}
                            </>
                          ) : (
                            <span className={`recurring-run recurring-run-${run.outcome}`}>
                              {outcomeLabel[run.outcome]}
                              {run.detail ? ` — ${run.detail}` : ""}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {(item.status === "active" || item.status === "paused" || clean > 0) && (
                  <div className="recurring-actions">
                    {clean > 0 && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => acceptClean(item)}
                      >
                        <Check size={14} /> Accept clean runs ({clean})
                      </button>
                    )}
                    {item.status === "active" && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act("Could not pause", () =>
                            call(`/super-agents/schedules/${item.id}/pause`, "POST"),
                          )
                        }
                      >
                        <Pause size={14} /> Pause
                      </button>
                    )}
                    {item.status === "paused" && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act("Could not resume", () =>
                            call(`/super-agents/schedules/${item.id}/resume`, "POST"),
                          )
                        }
                      >
                        <Play size={14} /> Resume
                      </button>
                    )}
                    {(item.status === "active" || item.status === "paused") && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => {
                          if (confirm("Stop watching this token? Checks already opened are kept."))
                            void act("Could not cancel", () =>
                              call(`/super-agents/schedules/${item.id}`, "DELETE"),
                            );
                        }}
                      >
                        <X size={14} /> Cancel
                      </button>
                    )}
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
