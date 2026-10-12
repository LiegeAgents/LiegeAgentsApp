import React, { useState, useEffect } from "react";
import { Copy, GitPullRequest, Pause, Play, X } from "lucide-react";

type CatalogAgent = {
  id: string;
  name: string;
  price_usd?: string | number;
  settlement_assets?: string[];
  service_settlement_assets?: string[];
};

type Run = {
  id: string;
  pull_number: number;
  title: string;
  outcome: "funded" | "awaiting_funding" | "skipped" | "failed";
  detail: string | null;
  job_status: string | null;
};

type Setup = {
  payloadUrl: string;
  contentType: string;
  secret: string;
  settingsUrl: string;
};

type Trigger = {
  id: string;
  agent_name: string;
  repository: string;
  branch: string;
  settlement_asset: "usdg" | "liege";
  budget_amount: string;
  spend_cap: string;
  committed_amount: string;
  runs_count: number;
  auto_fund: boolean;
  post_comment: boolean;
  verified_at: string | null;
  status: "active" | "paused" | "cancelled" | "completed";
  status_reason: string | null;
  runs: Run[];
  setup?: Setup;
};

const outcomeLabel: Record<Run["outcome"], string> = {
  funded: "Reviewing",
  awaiting_funding: "Waiting for your funding",
  skipped: "Skipped",
  failed: "Failed",
};

const amount = (value: string | number) => Number(value).toLocaleString();

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="setup-field">
      <span>{label}</span>
      <code>{value}</code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        <Copy size={13} /> {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** The four GitHub settings a trigger needs, with copyable values. */
function SetupSteps({ setup, onClose }: { setup: Setup; onClose: () => void }) {
  return (
    <div className="trigger-setup" role="region" aria-label="Connect GitHub">
      <header>
        <strong>Connect GitHub</strong>
        <button type="button" aria-label="Close setup" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <ol>
        <li>
          Open{" "}
          <a href={setup.settingsUrl} target="_blank" rel="noreferrer">
            your repository's webhook settings
          </a>{" "}
          and add a webhook.
        </li>
        <li>
          <CopyField label="Payload URL" value={setup.payloadUrl} />
        </li>
        <li>
          Content type: <code>{setup.contentType}</code>
        </li>
        <li>
          <CopyField label="Secret" value={setup.secret} />
        </li>
        <li>
          Choose <em>Let me select individual events</em>, tick <em>Pull requests</em> only, and
          save. The trigger shows <strong>Connected</strong> once GitHub says hello.
        </li>
      </ol>
    </div>
  );
}

export function Triggers({
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
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [asset, setAsset] = useState<"usdg" | "liege">("usdg");
  const [setup, setSetup] = useState<{ id: string; setup: Setup } | null>(null);
  const agent = agents.find((item) => item.id === agentId);
  const assets = (["usdg", "liege"] as const).filter((item) =>
    (agent?.service_settlement_assets ?? agent?.settlement_assets ?? ["usdg"]).includes(item),
  );

  useEffect(() => {
    if (agent && !assets.includes(asset)) setAsset(assets[0] ?? "usdg");
  }, [agentId]);
  // Marcus is the natural reviewer; preselect him when he is available.
  useEffect(() => {
    if (!agentId) {
      const marcus = agents.find((item) => item.name.toLowerCase().startsWith("marcus"));
      if (marcus) setAgentId(marcus.id);
    }
  }, [agents]);

  async function call(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1/super-agents/triggers${path}`, {
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
      .catch((error) => notify({ title: "Could not load GitHub triggers", body: error.message }))
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
    const instructions = String(form.get("instructions") ?? "").trim();
    void act("Trigger not created", async () => {
      const created: Trigger = await call("", "POST", {
        agentId,
        repository: String(form.get("repository") ?? "").trim(),
        branch: String(form.get("branch") ?? "").trim() || "main",
        ...(instructions ? { instructions } : {}),
        settlementAsset: asset,
        budgetAmount: Number(form.get("budget")),
        spendCap: Number(form.get("cap")),
        autoFund: form.get("autoFund") === "on",
        postComment: form.get("postComment") === "on",
        source: "dashboard",
      });
      element.reset();
      if (created.setup) setSetup({ id: created.id, setup: created.setup });
    });
  }

  return (
    <div className="recurring-grid">
      <section className="panel enrollment-panel enrollment-editor">
        <div className="panel-heading enrollment-heading">
          <h2>Review every pull request</h2>
          <span className="enrollment-kicker">ONE APPROVAL · CAPPED SPEND</span>
        </div>
        <form className="settings-content enrollment-content recurring-form" onSubmit={create}>
          <p>
            Connect a public GitHub repository and an agent reviews every pull request to your
            branch: when it opens and whenever new commits land. Each review is its own escrowed
            job, and the total never exceeds your cap.
          </p>
          <label className="enrollment-field" htmlFor="trigger-agent">
            Reviewer
          </label>
          <select
            id="trigger-agent"
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
              <span className="enrollment-field">Repository</span>
              <input
                className="trigger-input"
                name="repository"
                required
                placeholder="owner/repository"
              />
            </label>
            <label>
              <span className="enrollment-field">Branch</span>
              <input className="trigger-input" name="branch" placeholder="main" />
            </label>
          </div>
          <label className="enrollment-field" htmlFor="trigger-instructions">
            What to look for (optional)
          </label>
          <textarea
            id="trigger-instructions"
            name="instructions"
            maxLength={2000}
            rows={2}
            placeholder="Correctness, security, and maintainability, with concrete fixes."
          />
          <div className="recurring-row">
            <label>
              <span className="enrollment-field">Budget per review</span>
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
          <label className="recurring-toggle">
            <input name="postComment" type="checkbox" defaultChecked />
            <span>
              <strong>Post each review on the pull request</strong>
              <small>The full review always stays in Liege too.</small>
            </span>
          </label>
          <label className="recurring-toggle">
            <input name="autoFund" type="checkbox" />
            <span>
              <strong>Fund reviews automatically from my Liege balance</strong>
              <small>
                Only for jobs held in Liege escrow. Jobs that need an on-chain deposit always wait
                for your wallet.
              </small>
            </span>
          </label>
          <button className="button" type="submit" disabled={busy || !agentId}>
            <GitPullRequest size={15} /> Approve and connect
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Your GitHub triggers</h2>
          <span className="preview-label">
            {triggers.filter((item) => item.status === "active").length} active
          </span>
        </div>
        {setup && <SetupSteps setup={setup.setup} onClose={() => setSetup(null)} />}
        {loading ? (
          <p className="muted recurring-empty">Loading…</p>
        ) : !triggers.length ? (
          <div className="empty">
            <GitPullRequest size={28} />
            <h3>No repositories connected.</h3>
            <p>Push code, and the review is already on its way.</p>
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
              <article className="recurring-item trigger-item" key={item.id}>
                <header>
                  <div>
                    <strong>
                      {item.repository} · {item.branch}
                    </strong>
                    <small>
                      {item.agent_name} · {amount(item.budget_amount)} {unit} per review
                      {item.auto_fund ? " · auto-funded" : ""}
                      {item.post_comment ? " · comments on PRs" : ""}
                    </small>
                  </div>
                  <span className={`status status-${item.status}`}>{item.status}</span>
                </header>
                <small className={item.verified_at ? "trigger-connected" : "trigger-waiting"}>
                  {item.verified_at ? "Connected to GitHub" : "Waiting for GitHub to connect"}
                </small>
                <div className="recurring-meter" aria-label={`${used.toFixed(0)}% of cap used`}>
                  <span style={{ width: `${used}%` }} />
                </div>
                <small className="muted">
                  {amount(item.committed_amount)} of {amount(item.spend_cap)} {unit} committed ·{" "}
                  {item.runs_count} review{item.runs_count === 1 ? "" : "s"}
                </small>
                {item.status_reason && <small className="muted">{item.status_reason}</small>}
                {item.runs.slice(0, 3).map((run) => (
                  <small key={run.id} className={`recurring-run recurring-run-${run.outcome}`}>
                    #{run.pull_number} {run.title}: {outcomeLabel[run.outcome]}
                    {run.job_status === "submitted" || run.job_status === "completed"
                      ? " · delivered"
                      : ""}
                    {run.detail ? ` — ${run.detail}` : ""}
                  </small>
                ))}
                {open && (
                  <div className="recurring-actions">
                    {!item.verified_at && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          act("Could not load setup", async () => {
                            const full: Trigger = await call(`/${item.id}`);
                            if (full.setup) setSetup({ id: item.id, setup: full.setup });
                          })
                        }
                      >
                        Show setup
                      </button>
                    )}
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
                        if (confirm("Disconnect this repository? Reviews already opened are kept."))
                          void act("Could not cancel", () => call(`/${item.id}`, "DELETE"));
                      }}
                    >
                      <X size={14} /> Disconnect
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
