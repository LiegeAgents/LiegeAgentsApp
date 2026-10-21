import React, { useEffect, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";

type HireKey = {
  id: string;
  name: string;
  max_budget_per_hire: string;
  daily_budget: string;
  proposed_today: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

type Created = {
  id: string;
  token: string;
  expiresAt: string;
  presets: Record<string, { name: string; filename: string; config: unknown }>;
};

const amount = (value: string | number) => Number(value).toLocaleString();
const tools = [
  "find_super_agents",
  "quote_hire",
  "propose_hire",
  "counter_hire_quote",
  "list_my_hires",
  "get_hire_result",
];

export function HireKeys({
  api,
  token,
  notify,
}: {
  api: string;
  token: string;
  notify: (notice: { title: string; body: string }) => void;
}) {
  const [keys, setKeys] = useState<HireKey[]>([]);
  const [created, setCreated] = useState<Created | null>(null);
  const [preset, setPreset] = useState("claude_desktop");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function request(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1/mcp/hire-keys${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || "The request could not be made.");
    return result.data;
  }

  const load = () => request("").then(setKeys);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [api, token]);

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    void request("", "POST", {
      name: String(form.get("name") ?? "").trim(),
      maxBudgetPerHire: Number(form.get("maxBudgetPerHire")),
      dailyBudget: Number(form.get("dailyBudget")),
    })
      .then((key: Created) => {
        setCreated(key);
        setCopied(false);
        return load();
      })
      .catch((error: Error) => notify({ title: "Key not created", body: error.message }))
      .finally(() => setBusy(false));
  }

  function revoke(key: HireKey) {
    void request(`/${key.id}`, "DELETE")
      .then(() => {
        if (created?.id === key.id) setCreated(null);
        notify({ title: "Key revoked", body: `${key.name} can no longer propose work.` });
        return load();
      })
      .catch((error: Error) => notify({ title: "Key not revoked", body: error.message }));
  }

  const config = created ? JSON.stringify(created.presets[preset]?.config, null, 2) : "";

  return (
    <div className="recurring-grid">
      <section className="panel enrollment-panel enrollment-editor">
        <div className="panel-heading enrollment-heading">
          <h2>New hiring key</h2>
          <span className="enrollment-kicker">PROPOSES ONLY · YOU APPROVE AND FUND</span>
        </div>
        <form className="settings-content enrollment-content recurring-form" onSubmit={create}>
          <p>
            Give your own AI agent (Claude Desktop, Cursor, or any MCP client) a key to find, quote,
            and propose Super Agent work. Its proposals land in Requests for you to approve and
            fund. The key cannot approve, fund, or pay, and it stays within the limits below.
          </p>
          <label className="enrollment-field" htmlFor="hire-key-name">
            Name
          </label>
          <input
            id="hire-key-name"
            className="hire-key-name"
            name="name"
            required
            minLength={2}
            maxLength={80}
            placeholder="My research assistant"
          />
          <div className="recurring-row">
            <label>
              <span className="enrollment-field">Most per hire (USDG)</span>
              <input
                name="maxBudgetPerHire"
                type="number"
                min="0.01"
                step="0.01"
                required
                defaultValue={5}
              />
            </label>
            <label>
              <span className="enrollment-field">Daily budget (USDG)</span>
              <input
                name="dailyBudget"
                type="number"
                min="0.01"
                step="0.01"
                required
                defaultValue={20}
              />
            </label>
          </div>
          <button className="button" type="submit" disabled={busy}>
            <KeyRound size={15} /> {busy ? "Creating…" : "Create key"}
          </button>
        </form>
        {created && (
          <article className="recurring-item hire-key-created">
            <header>
              <strong>
                <Check size={14} /> Copy this key now. It is shown once.
              </strong>
              <small>Expires {new Date(created.expiresAt).toLocaleDateString()}</small>
            </header>
            <div className="recurring-row">
              <label>
                <span className="enrollment-field">Configuration for</span>
                <select value={preset} onChange={(event) => setPreset(event.target.value)}>
                  {Object.entries(created.presets).map(([id, item]) => (
                    <option key={id} value={id}>
                      {item.name} ({item.filename})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <pre>{config}</pre>
            <button
              className="button secondary"
              type="button"
              onClick={() => void navigator.clipboard.writeText(config).then(() => setCopied(true))}
            >
              <Copy size={15} /> {copied ? "Copied" : "Copy configuration"}
            </button>
            <p className="muted">Your agent gets these tools: {tools.join(", ")}.</p>
          </article>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Your hiring keys</h2>
          <span className="preview-label">
            {keys.filter((key) => !key.revoked_at).length} active
          </span>
        </div>
        {!keys.length ? (
          <p className="muted recurring-empty">No hiring keys yet.</p>
        ) : (
          keys.map((key) => (
            <article className="recurring-item hire-key-item" key={key.id}>
              <header>
                <div>
                  <strong>{key.name}</strong>
                  <small>
                    Up to {amount(key.max_budget_per_hire)} USDG per hire ·{" "}
                    {amount(key.proposed_today)} of {amount(key.daily_budget)} USDG proposed today
                  </small>
                  <small>
                    {key.last_used_at
                      ? `Last used ${new Date(key.last_used_at).toLocaleString()}`
                      : "Not used yet"}
                    {" · "}
                    {key.revoked_at
                      ? "Revoked"
                      : `Expires ${new Date(key.expires_at).toLocaleDateString()}`}
                  </small>
                </div>
                {key.revoked_at ? (
                  <span className="watch-tag muted">Revoked</span>
                ) : (
                  <button className="button secondary" type="button" onClick={() => revoke(key)}>
                    Revoke
                  </button>
                )}
              </header>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
