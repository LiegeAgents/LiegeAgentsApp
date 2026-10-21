import React, { useEffect, useState } from "react";
import { Check, X, Zap } from "lucide-react";

type CatalogAgent = {
  id: string;
  name: string;
  call_price_usdg?: string | number | null;
  call_price_liege?: string | number | null;
};

type Call = {
  id: string;
  agentName: string;
  settlementAsset: "usdg" | "liege";
  price: string;
  status: "pending" | "succeeded" | "refunded";
  charged: boolean;
  role: "client" | "agent_owner";
  input?: string | null;
  output?: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
};

const amount = (value: string | number) => Number(value).toLocaleString();
const priceOf = (agent: CatalogAgent, asset: "usdg" | "liege") =>
  asset === "usdg" ? agent.call_price_usdg : agent.call_price_liege;

export function Instant({
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
  // Only agents whose owners set a per-call price take instant calls.
  const callable = agents.filter((agent) => agent.call_price_usdg || agent.call_price_liege);
  const [agentId, setAgentId] = useState("");
  const [asset, setAsset] = useState<"usdg" | "liege">("usdg");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Call | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const agent = callable.find((item) => item.id === agentId) ?? callable[0];
  const assets = agent
    ? (["usdg", "liege"] as const).filter((item) => priceOf(agent, item))
    : ([] as Array<"usdg" | "liege">);
  const price = agent && assets.includes(asset) ? priceOf(agent, asset) : undefined;

  useEffect(() => {
    if (assets.length && !assets.includes(asset)) setAsset(assets[0]);
  }, [agent?.id]);

  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(new Error(result.error?.message || "The call could not be made."), {
        call: result.data as Call | undefined,
      });
    return result.data;
  }

  const load = () => request("/super-agents/calls").then(setCalls);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [api, token]);

  function ask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agent || busy) return;
    const input = String(new FormData(event.currentTarget).get("input") ?? "").trim();
    if (!input) return;
    setBusy(true);
    setAnswer(null);
    void request("/super-agents/calls", "POST", {
      agentId: agent.id,
      input,
      settlementAsset: asset,
      idempotencyKey: `web-${crypto.randomUUID()}`,
    })
      .then((call: Call) => setAnswer(call))
      .catch((error: Error & { call?: Call }) => {
        if (error.call) setAnswer(error.call);
        notify({ title: "Call refunded", body: error.message });
      })
      .finally(() => {
        setBusy(false);
        void load().catch(() => undefined);
      });
  }

  return (
    <div className="recurring-grid">
      <section className="panel enrollment-panel enrollment-editor">
        <div className="panel-heading enrollment-heading">
          <h2>Ask instantly</h2>
          <span className="enrollment-kicker">PAY PER CALL · REFUNDED IF IT FAILS</span>
        </div>
        {!callable.length ? (
          <div className="empty">
            <Zap size={28} />
            <h3>No agent takes instant calls yet.</h3>
            <p>Agents appear here once their owners set a price per call.</p>
          </div>
        ) : (
          <form className="settings-content enrollment-content recurring-form" onSubmit={ask}>
            <p>
              For small requests you want answered now. The price comes from your Liege balance and
              goes to the agent only when it answers. If it declines, times out, or fails, you are
              refunded in full. There is no review step, so use a job for larger work.
            </p>
            <div className="recurring-row">
              <label>
                <span className="enrollment-field">Agent</span>
                <select value={agent?.id} onChange={(event) => setAgentId(event.target.value)}>
                  {callable.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
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
            <label className="enrollment-field" htmlFor="instant-input">
              Request
            </label>
            <textarea
              id="instant-input"
              name="input"
              required
              maxLength={8000}
              rows={4}
              placeholder="Check 0x… on Robinhood Chain"
            />
            <button className="button" type="submit" disabled={busy || !price}>
              <Zap size={15} />{" "}
              {busy
                ? "Waiting for the answer…"
                : `Ask · ${price ? amount(price) : "–"} ${asset.toUpperCase()}`}
            </button>
            {agent?.call_price_usdg && (
              <p className="muted instant-x402">
                Apps and agents without a Liege account can pay per call in USDG over x402:{" "}
                <code>POST {`${api}/v1/x402/calls/${agent.id}`}</code>
              </p>
            )}
          </form>
        )}
        {answer && (
          <article className="recurring-item instant-answer">
            <header>
              <strong>
                {answer.status === "succeeded" ? <Check size={14} /> : <X size={14} />}{" "}
                {answer.agentName}
              </strong>
              <small>
                {answer.charged
                  ? `Charged ${amount(answer.price)} ${answer.settlementAsset.toUpperCase()}`
                  : "Refunded, not charged"}
                {answer.durationMs !== null ? ` · ${(answer.durationMs / 1000).toFixed(1)}s` : ""}
              </small>
            </header>
            {answer.output ? <pre>{answer.output}</pre> : <p>{answer.error}</p>}
          </article>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Recent calls</h2>
          <span className="preview-label">{calls.length} shown</span>
        </div>
        {!calls.length ? (
          <p className="muted recurring-empty">No calls yet.</p>
        ) : (
          calls.map((call) => (
            <article className="recurring-item" key={call.id}>
              <header>
                <div>
                  <strong>{call.agentName}</strong>
                  <small>
                    {call.role === "agent_owner" ? "Answered by your agent · " : ""}
                    {new Date(call.createdAt).toLocaleString()}
                  </small>
                </div>
                <span className={`watch-tag ${call.charged ? "" : "muted"}`}>
                  {call.status === "succeeded"
                    ? `${amount(call.price)} ${call.settlementAsset.toUpperCase()}`
                    : call.status === "pending"
                      ? "Waiting"
                      : "Refunded"}
                </span>
              </header>
              {call.error && <p>{call.error}</p>}
            </article>
          ))
        )}
      </section>
    </div>
  );
}
