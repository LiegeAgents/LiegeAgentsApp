import React, { useEffect, useState } from "react";
import { Milestone } from "lucide-react";
import { Button, Field, Notice } from "./UI";
import { api } from "./api";
import SuperAgentPicker from "./SuperAgentPicker";

const LABEL = { usdg: "USDG", liege: "LIEGE" };
const blankStep = () => ({ title: "", criteria: "", amount: "" });
const STATUS = {
  running: "Running",
  completed: "Complete",
  stopped: "Stopped",
  cancelled: "Cancelled",
};

/**
 * Milestone escrow. The whole budget is locked from the Liege balance when the plan starts, so the
 * agent knows the project is paid for; each milestone is its own job, paid when accepted, and the
 * next starts then. A rejected milestone or a cancel returns what never started.
 */
export default function MilestonePlans({ token }) {
  const [plans, setPlans] = useState(null),
    [creating, setCreating] = useState(false),
    [draft, setDraft] = useState({
      agentId: "",
      title: "",
      brief: "",
      asset: "usdg",
      steps: [blankStep(), blankStep()],
    }),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(null);
  const load = () =>
    api
      .milestonePlans(token)
      .then((result) => setPlans(result.data))
      .catch(() => setPlans(null));
  useEffect(() => {
    void load();
  }, [token]);
  if (!plans) return null;
  const setStep = (index, patch) =>
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
  const total = draft.steps.reduce((sum, step) => sum + (Number(step.amount) || 0), 0);
  const ready =
    draft.agentId &&
    draft.title.trim().length >= 3 &&
    draft.brief.trim() &&
    draft.steps.every(
      (step) => step.title.trim() && step.criteria.trim() && Number(step.amount) > 0,
    );
  const run = async (work, done) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await load();
      setMessage({ text: done });
    } catch (e) {
      setMessage({ error: true, text: e?.message || "That did not work. Try again." });
    } finally {
      setBusy(false);
    }
  };
  const create = () =>
    run(async () => {
      await api.createMilestonePlan(token, {
        agentId: draft.agentId,
        title: draft.title.trim(),
        brief: draft.brief.trim(),
        settlementAsset: draft.asset,
        milestones: draft.steps.map((step) => ({
          title: step.title.trim(),
          acceptanceCriteria: step.criteria
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          amount: Number(step.amount),
        })),
      });
      setCreating(false);
      setDraft({
        agentId: "",
        title: "",
        brief: "",
        asset: "usdg",
        steps: [blankStep(), blankStep()],
      });
    }, "Plan started. The budget is locked and the first milestone is with the agent.");
  const cancel = (plan) =>
    run(
      () => api.cancelMilestonePlan(token, plan.id),
      "Plan cancelled. Milestones that never started went back to your balance.",
    );
  return (
    <div className="settings-panel milestone-plans">
      <h2>
        <Milestone size={16} /> Milestone plans
      </h2>
      <p>
        Lock a project's budget for one Super Agent up front, split into milestones. Each one is
        paid when you accept it, and the next starts then. A rejected milestone or a cancel returns
        what never started to your balance.
      </p>
      {plans.map((plan) => {
        const asset = LABEL[plan.asset] || plan.asset;
        return (
          <article key={plan.id} className="milestone-plan">
            <header>
              <strong>{plan.title}</strong>
              <small>
                {plan.agentName} · {STATUS[plan.status] || plan.status} · {plan.paid} of{" "}
                {plan.total} {asset} paid
              </small>
            </header>
            <ol>
              {plan.milestones.map((step) => (
                <li key={step.position} className={`milestone-step ${step.jobStatus || "waiting"}`}>
                  <span>{step.title}</span>
                  <small>
                    {step.amount} {asset} · {step.jobStatus || "not started"}
                  </small>
                </li>
              ))}
            </ol>
            {plan.statusReason && plan.status !== "running" && (
              <p className="muted">
                {plan.statusReason}
                {Number(plan.released) > 0 &&
                  ` ${plan.released} ${asset} returned to your balance.`}
              </p>
            )}
            {plan.status === "running" && (
              <div className="receipt-actions">
                <Button small secondary disabled={busy} onClick={() => cancel(plan)}>
                  Cancel plan
                </Button>
              </div>
            )}
          </article>
        );
      })}
      {creating ? (
        <div className="milestone-form">
          <SuperAgentPicker
            asset={draft.asset}
            value={draft.agentId}
            onChange={(agentId) => setDraft((current) => ({ ...current, agentId }))}
          />
          <Field label="Project title">
            <input
              maxLength={160}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field label="Brief">
            <textarea
              rows={3}
              maxLength={10000}
              value={draft.brief}
              onChange={(e) => setDraft({ ...draft, brief: e.target.value })}
            />
          </Field>
          <Field label="Pay in">
            <select
              value={draft.asset}
              onChange={(e) => setDraft({ ...draft, asset: e.target.value })}
            >
              <option value="usdg">USDG</option>
              <option value="liege">LIEGE</option>
            </select>
          </Field>
          {draft.steps.map((step, index) => (
            <fieldset key={index} className="milestone-draft">
              <legend>Milestone {index + 1}</legend>
              <Field label="Title">
                <input
                  maxLength={160}
                  value={step.title}
                  onChange={(e) => setStep(index, { title: e.target.value })}
                />
              </Field>
              <Field label="Acceptance criteria (one per line)">
                <textarea
                  rows={2}
                  value={step.criteria}
                  onChange={(e) => setStep(index, { criteria: e.target.value })}
                />
              </Field>
              <Field label={`Amount (${LABEL[draft.asset]})`}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={step.amount}
                  onChange={(e) => setStep(index, { amount: e.target.value })}
                />
              </Field>
              {draft.steps.length > 2 && (
                <Button
                  small
                  secondary
                  onClick={() =>
                    setDraft({ ...draft, steps: draft.steps.filter((_, i) => i !== index) })
                  }
                >
                  Remove
                </Button>
              )}
            </fieldset>
          ))}
          <div className="receipt-actions">
            {draft.steps.length < 8 && (
              <Button
                small
                secondary
                onClick={() => setDraft({ ...draft, steps: [...draft.steps, blankStep()] })}
              >
                Add milestone
              </Button>
            )}
            <Button small disabled={busy || !ready} onClick={create}>
              {busy ? "Starting…" : `Lock ${+total.toFixed(6)} ${LABEL[draft.asset]} and start`}
            </Button>
            <Button small secondary onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="receipt-actions">
          <Button small secondary onClick={() => setCreating(true)}>
            New milestone plan
          </Button>
        </div>
      )}
      {message && <Notice error={message.error}>{message.text}</Notice>}
    </div>
  );
}
