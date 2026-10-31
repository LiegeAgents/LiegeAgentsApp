import React, { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { Button, Field, Notice } from "./UI";
import { api } from "./api";

const LABEL = { usdg: "USDG", liege: "LIEGE" };
const when = (value) => new Date(value).toLocaleDateString();
const blank = {
  agentId: "",
  title: "",
  asset: "usdg",
  period: "month",
  budget: "",
  autoRenew: true,
};

/**
 * Retainers. A Super Agent kept on a weekly or monthly budget locked from the Liege balance; each
 * task is a job funded from it at once. Undrawn budget returns when the period ends. Agent owners
 * see the retainers on their agents here too.
 */
export default function Retainers({ token, agents = [] }) {
  const [items, setItems] = useState(null),
    [creating, setCreating] = useState(false),
    [draft, setDraft] = useState(blank),
    [tasks, setTasks] = useState({}),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(null);
  const load = () =>
    api
      .retainers(token)
      .then((result) => setItems(result.data))
      .catch(() => setItems(null));
  useEffect(() => {
    void load();
  }, [token]);
  if (!items) return null;
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
      await api.createRetainer(token, {
        agentId: draft.agentId,
        title: draft.title.trim(),
        settlementAsset: draft.asset,
        period: draft.period,
        budget: Number(draft.budget),
        autoRenew: draft.autoRenew,
      });
      setCreating(false);
      setDraft(blank);
    }, "Retainer started. This period's budget is locked; send the agent tasks below.");
  const send = (item) =>
    run(async () => {
      const draftTask = tasks[item.id] || {};
      await api.retainerTask(token, item.id, draftTask.request.trim(), Number(draftTask.amount));
      setTasks((current) => ({ ...current, [item.id]: {} }));
    }, "Task sent and funded from the retainer.");
  const cancel = (item) =>
    run(
      () => api.cancelRetainer(token, item.id),
      "Retainer ended. This period's unused budget went back to your balance.",
    );
  return (
    <div className="settings-panel retainers">
      <h2>
        <CalendarClock size={16} /> Retainers
      </h2>
      <p>
        Keep a Super Agent on a weekly or monthly budget. Each task you send is funded from it at
        once, and whatever you don't use comes back when the period ends.
      </p>
      {items.map((item) => {
        const asset = LABEL[item.asset] || item.asset;
        const draftTask = tasks[item.id] || {};
        return (
          <article key={item.id} className="retainer">
            <header>
              <strong>{item.title}</strong>
              <small>
                {item.role === "agent" ? `Your agent ${item.agentName}` : item.agentName} ·{" "}
                {item.budget} {asset} a {item.period} ·{" "}
                {item.status === "active"
                  ? `${item.left} left until ${when(item.periodEndsAt)}${item.autoRenew ? ", then renews" : ""}`
                  : item.statusReason || item.status}
              </small>
            </header>
            {item.tasks.length > 0 && (
              <ul>
                {item.tasks.slice(0, 5).map((t) => (
                  <li key={t.jobId}>
                    <span>{t.title}</span>
                    <small>
                      {t.amount} {asset} · {t.status}
                    </small>
                  </li>
                ))}
              </ul>
            )}
            {item.role === "client" && item.status === "active" && (
              <div className="retainer-task">
                <Field label="New task">
                  <textarea
                    rows={2}
                    maxLength={10000}
                    value={draftTask.request || ""}
                    onChange={(e) =>
                      setTasks({ ...tasks, [item.id]: { ...draftTask, request: e.target.value } })
                    }
                  />
                </Field>
                <Field label={`Amount (${asset})`}>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={draftTask.amount || ""}
                    onChange={(e) =>
                      setTasks({ ...tasks, [item.id]: { ...draftTask, amount: e.target.value } })
                    }
                  />
                </Field>
                <div className="receipt-actions">
                  <Button
                    small
                    disabled={busy || !draftTask.request?.trim() || !(Number(draftTask.amount) > 0)}
                    onClick={() => send(item)}
                  >
                    Send task
                  </Button>
                  <Button small secondary disabled={busy} onClick={() => cancel(item)}>
                    End retainer
                  </Button>
                </div>
              </div>
            )}
          </article>
        );
      })}
      {creating ? (
        <div className="retainer-form">
          <Field label="Super Agent">
            <select
              value={draft.agentId}
              onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
            >
              <option value="">Choose an agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="What it's for">
            <input
              maxLength={160}
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field label="Every">
            <select
              value={draft.period}
              onChange={(e) => setDraft({ ...draft, period: e.target.value })}
            >
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
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
          <Field label={`Budget per ${draft.period} (${LABEL[draft.asset]})`}>
            <input
              type="number"
              min="0"
              step="any"
              value={draft.budget}
              onChange={(e) => setDraft({ ...draft, budget: e.target.value })}
            />
          </Field>
          <label className="retainer-renew">
            <input
              type="checkbox"
              checked={draft.autoRenew}
              onChange={(e) => setDraft({ ...draft, autoRenew: e.target.checked })}
            />{" "}
            Renew automatically each {draft.period}
          </label>
          <div className="receipt-actions">
            <Button
              small
              disabled={
                busy ||
                !draft.agentId ||
                draft.title.trim().length < 3 ||
                !(Number(draft.budget) > 0)
              }
              onClick={create}
            >
              {busy ? "Starting…" : "Lock budget and start"}
            </Button>
            <Button small secondary onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="receipt-actions">
          <Button small secondary onClick={() => setCreating(true)}>
            New retainer
          </Button>
        </div>
      )}
      {message && <Notice error={message.error}>{message.text}</Notice>}
    </div>
  );
}
