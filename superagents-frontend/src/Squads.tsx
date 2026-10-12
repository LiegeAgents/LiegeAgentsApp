import React, { useEffect, useState } from "react";
import { ArrowRight, Plus, Workflow, X } from "lucide-react";

type CatalogAgent = {
  id: string;
  name: string;
  price_usd?: string | number;
  settlement_assets?: string[];
  service_settlement_assets?: string[];
};

type Step = {
  position: number;
  agent_name: string;
  task: string;
  budget_amount: string | number;
  job_id: string | null;
  job_status: string | null;
  detail: string | null;
  progress: { message: string } | null;
};

type Squad = {
  id: string;
  name: string;
  settlement_asset: "usdg" | "liege";
  total_budget: string;
  auto_fund: boolean;
  status: "running" | "completed" | "stopped" | "cancelled";
  status_reason: string | null;
  steps: Step[];
};

type Draft = { agentId: string; task: string; budget: string };

// Ready-made crews. Each step names the flagship agent by first name.
const templates: Array<{ name: string; request: string; steps: Array<[string, string]> }> = [
  {
    name: "Product launch",
    request: "Plan the launch of my product.",
    steps: [
      ["Anna", "Research the market and the main competitors"],
      ["Daniel", "Turn the research into a launch plan"],
      ["Scott", "Write the launch copy"],
    ],
  },
  {
    name: "Ship it safely",
    request: "Get my code ready to ship.",
    steps: [
      ["Marcus", "Review the code for bugs and security issues"],
      ["Daniel", "Plan the fixes and the rollout"],
    ],
  },
  {
    name: "Brand refresh",
    request: "Refresh my brand.",
    steps: [
      ["Anna", "Research how competitors present themselves"],
      ["Chloe", "Design the new visual direction"],
      ["Scott", "Write the new messaging"],
    ],
  },
];

const stepState: Record<string, string> = {
  open: "Needs funding",
  funded: "Working",
  submitted: "Delivered",
  completed: "Accepted",
  rejected: "Rejected",
  expired: "Expired",
};

const amount = (value: string | number) => Number(value).toLocaleString();
const blank = (): Draft => ({ agentId: "", task: "", budget: "" });

export function Squads({
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
  const [squads, setSquads] = useState<Squad[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [request, setRequest] = useState("");
  const [steps, setSteps] = useState<Draft[]>([blank(), blank()]);
  const [asset, setAsset] = useState<"usdg" | "liege">("usdg");
  const [autoFund, setAutoFund] = useState(false);

  const chosen = steps.map((step) => agents.find((agent) => agent.id === step.agentId));
  // Every agent in the crew must accept the settlement asset.
  const assets = (["usdg", "liege"] as const).filter((item) =>
    chosen.every(
      (agent) =>
        !agent ||
        (agent.service_settlement_assets ?? agent.settlement_assets ?? ["usdg"]).includes(item),
    ),
  );
  const total = steps.reduce((sum, step) => sum + (Number(step.budget) || 0), 0);
  const ready =
    request.trim() &&
    steps.every((step) => step.agentId && step.task.trim() && Number(step.budget) > 0) &&
    assets.includes(asset);

  useEffect(() => {
    if (!assets.includes(asset) && assets[0]) setAsset(assets[0]);
  }, [steps]);

  async function call(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1/super-agents/squads${path}`, {
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
    setSquads(await call(""));
  }

  useEffect(() => {
    void load()
      .catch((error) => notify({ title: "Could not load squads", body: error.message }))
      .finally(() => setLoading(false));
    // Steps hand off on their own; refresh so the pipeline moves without a reload.
    const timer = setInterval(() => void load().catch(() => undefined), 15_000);
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

  function applyTemplate(template: (typeof templates)[number]) {
    setName(template.name);
    setRequest(template.request);
    setSteps(
      template.steps.map(([first, task]) => {
        const agent = agents.find((item) =>
          item.name.toLowerCase().startsWith(first.toLowerCase()),
        );
        return {
          agentId: agent?.id ?? "",
          task,
          budget: agent?.price_usd ? String(Number(agent.price_usd)) : "",
        };
      }),
    );
  }

  const update = (index: number, change: Partial<Draft>) =>
    setSteps(steps.map((step, position) => (position === index ? { ...step, ...change } : step)));

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void act("Squad not started", async () => {
      await call("", "POST", {
        ...(name.trim() ? { name: name.trim() } : {}),
        request: request.trim(),
        settlementAsset: asset,
        autoFund,
        source: "dashboard",
        steps: steps.map((step) => ({
          agentId: step.agentId,
          task: step.task.trim(),
          budgetAmount: Number(step.budget),
        })),
      });
      setName("");
      setRequest("");
      setSteps([blank(), blank()]);
      notify({
        title: "Squad started",
        body: autoFund
          ? "The first agent is on it. Each step starts as soon as the one before it delivers."
          : "The first step is waiting for your funding. Each step starts as soon as the one before it delivers.",
      });
    });
  }

  return (
    <div className="recurring-grid">
      <section className="panel enrollment-panel enrollment-editor">
        <div className="panel-heading enrollment-heading">
          <h2>New squad</h2>
          <span className="enrollment-kicker">ONE APPROVAL · PAY PER STEP</span>
        </div>
        <form className="settings-content enrollment-content recurring-form" onSubmit={create}>
          <p>
            Line up 2 to 5 agents for one request. Each step is its own escrowed job, and each agent
            picks up everything the earlier steps delivered. You accept or reject each step on its
            own, so every agent is paid only for its part.
          </p>
          <div className="squad-templates" aria-label="Templates">
            {templates.map((template) => (
              <button
                type="button"
                key={template.name}
                className="squad-template"
                onClick={() => applyTemplate(template)}
              >
                <strong>{template.name}</strong>
                <small>{template.steps.map(([first]) => first).join(" → ")}</small>
              </button>
            ))}
          </div>
          <label className="enrollment-field" htmlFor="squad-request">
            What should the squad deliver?
          </label>
          <textarea
            id="squad-request"
            required
            maxLength={10000}
            rows={3}
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            placeholder="Plan the launch of Notely, a note-taking app for students."
          />
          <label className="enrollment-field" htmlFor="squad-name">
            Name (optional)
          </label>
          <input
            id="squad-name"
            className="squad-name"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <ol className="squad-steps">
            {steps.map((step, index) => (
              <li key={index}>
                <span className="squad-step-number">{index + 1}</span>
                <div className="squad-step-fields">
                  <select
                    aria-label={`Step ${index + 1} agent`}
                    required
                    value={step.agentId}
                    onChange={(event) => {
                      const agent = agents.find((item) => item.id === event.target.value);
                      update(index, {
                        agentId: event.target.value,
                        ...(!step.budget && agent?.price_usd
                          ? { budget: String(Number(agent.price_usd)) }
                          : {}),
                      });
                    }}
                  >
                    <option value="">Choose an agent</option>
                    {agents.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`Step ${index + 1} task`}
                    required
                    maxLength={500}
                    placeholder="What this agent does"
                    value={step.task}
                    onChange={(event) => update(index, { task: event.target.value })}
                  />
                  <input
                    aria-label={`Step ${index + 1} budget`}
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    placeholder="Budget"
                    value={step.budget}
                    onChange={(event) => update(index, { budget: event.target.value })}
                  />
                </div>
                {steps.length > 2 && (
                  <button
                    type="button"
                    className="squad-remove"
                    aria-label={`Remove step ${index + 1}`}
                    onClick={() => setSteps(steps.filter((_, position) => position !== index))}
                  >
                    <X size={14} />
                  </button>
                )}
              </li>
            ))}
          </ol>
          {steps.length < 5 && (
            <button
              type="button"
              className="button secondary squad-add"
              onClick={() => setSteps([...steps, blank()])}
            >
              <Plus size={14} /> Add a step
            </button>
          )}
          <div className="recurring-row">
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
            <div className="squad-total">
              <span className="enrollment-field">Total</span>
              <strong>
                {amount(total)} {asset.toUpperCase()}
              </strong>
            </div>
          </div>
          <label className="recurring-toggle">
            <input
              type="checkbox"
              checked={autoFund}
              onChange={(event) => setAutoFund(event.target.checked)}
            />
            <span>
              <strong>Fund each step automatically from my Liege balance</strong>
              <small>
                The next step is funded the moment the one before it delivers. Jobs that need an
                on-chain deposit always wait for your wallet.
              </small>
            </span>
          </label>
          <button className="button" type="submit" disabled={busy || !ready}>
            <Workflow size={15} /> Approve squad
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Your squads</h2>
          <span className="preview-label">
            {squads.filter((item) => item.status === "running").length} running
          </span>
        </div>
        {loading ? (
          <p className="muted recurring-empty">Loading…</p>
        ) : !squads.length ? (
          <div className="empty">
            <Workflow size={28} />
            <h3>No squads yet.</h3>
            <p>Pick a template to see a crew hand work from one agent to the next.</p>
          </div>
        ) : (
          squads.map((squad) => (
            <article className="recurring-item squad-item" key={squad.id}>
              <header>
                <div>
                  <strong>{squad.name}</strong>
                  <small>
                    {squad.steps.length} agents · {amount(squad.total_budget)}{" "}
                    {squad.settlement_asset.toUpperCase()}
                    {squad.auto_fund ? " · auto-funded" : ""}
                  </small>
                </div>
                <span className={`status status-${squad.status}`}>{squad.status}</span>
              </header>
              <ol className="squad-pipeline">
                {squad.steps.map((step, index) => (
                  <li
                    key={step.position}
                    className={`squad-stage squad-stage-${step.job_status ?? "queued"}`}
                  >
                    {index > 0 && <ArrowRight size={13} aria-hidden="true" />}
                    <div>
                      <strong>{step.agent_name}</strong>
                      <small>{step.task}</small>
                      <em>
                        {step.job_status
                          ? (stepState[step.job_status] ?? step.job_status)
                          : "Queued"}
                        {step.job_status === "funded" && step.progress
                          ? ` · ${step.progress.message}`
                          : ""}
                      </em>
                      {step.detail && step.job_status === "open" && <small>{step.detail}</small>}
                    </div>
                  </li>
                ))}
              </ol>
              {squad.status_reason && <small className="muted">{squad.status_reason}</small>}
              {squad.status === "running" && (
                <div className="recurring-actions">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      if (confirm("Cancel this squad? Steps already started are kept."))
                        void act("Could not cancel", () => call(`/${squad.id}/cancel`, "POST"));
                    }}
                  >
                    <X size={14} /> Cancel
                  </button>
                </div>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  );
}
