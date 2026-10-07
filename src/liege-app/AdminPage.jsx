import React, { useEffect, useState } from "react";
import { ArrowLeft, LockKeyhole, LogOut, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import "./admin.css";

const tokenKey = "liege_admin_token";
const request = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status}).`);
  return body?.data ?? body;
};

const number = (value) => Number(value ?? 0).toLocaleString();

function Login({ onLogin }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await request("/v1/admin/session", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      onLogin(session.token);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="admin-shell">
      <section className="admin-login">
        <div className="admin-mark">
          <LockKeyhole size={20} />
        </div>
        <span className="admin-kicker">LIEGE / ADMIN</span>
        <h1>Platform control room.</h1>
        <p>Enter the master admin code to view private platform metrics.</p>
        <form onSubmit={submit}>
          <label htmlFor="master-admin-code">Master admin code</label>
          <input
            id="master-admin-code"
            type="password"
            autoComplete="current-password"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoFocus
          />
          <button disabled={busy || !code}>{busy ? "Checking…" : "Open metrics"}</button>
          {error && (
            <div className="admin-error" role="alert">
              {error}
            </div>
          )}
        </form>
        <a className="admin-back" href="/">
          <ArrowLeft size={14} /> Back to Liege
        </a>
      </section>
    </main>
  );
}

function Dashboard({ token, onLogout }) {
  const [metrics, setMetrics] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      setMetrics(await request("/v1/admin/metrics", { token }));
    } catch (cause) {
      if (cause.message.toLowerCase().includes("session")) onLogout();
      else setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  if (!metrics)
    return (
      <main className="admin-shell">
        <div className="admin-loading">{error || "Loading platform metrics…"}</div>
      </main>
    );
  const cards = [
    ["Users", metrics.users],
    ["Agents", `${number(metrics.agents.active)} / ${number(metrics.agents.total)}`, "active"],
    ["Jobs", metrics.jobs.total],
    [
      "Super Agents",
      `${number(metrics.superAgents.enabled)} / ${number(metrics.superAgents.total)}`,
      "enabled",
    ],
    ["Evaluators", metrics.evaluators],
    ["MCP connections", metrics.activeMcpConnections],
  ];
  return (
    <main className="admin-shell">
      <div className="admin-dashboard">
        <header className="admin-header">
          <div>
            <span className="admin-kicker">
              <ShieldCheck size={13} /> LIEGE / ADMIN
            </span>
            <h1>Platform metrics.</h1>
            <p>Operational visibility across the Liege marketplace and Super Agents.</p>
          </div>
          <div className="admin-actions">
            <button onClick={load} disabled={busy}>
              <RefreshCw size={14} /> {busy ? "Refreshing…" : "Refresh"}
            </button>
            <button onClick={onLogout}>
              <LogOut size={14} /> Sign out
            </button>
          </div>
        </header>
        <div className="admin-grid">
          {cards.map(([label, value, detail]) => (
            <section className="admin-card" key={label}>
              <span>{label}</span>
              <strong>
                {typeof value === "string" && value.includes("/") ? value : number(value)}
              </strong>
              {detail && <small>{detail}</small>}
            </section>
          ))}
        </div>
        <div className="admin-panels">
          <section className="admin-panel">
            <h2>Jobs by status</h2>
            <div className="admin-rows">
              {metrics.jobs.byStatus.map((row) => (
                <div key={row.status}>
                  <span>{row.status}</span>
                  <b>{number(row.count)}</b>
                </div>
              ))}
            </div>
          </section>
          <section className="admin-panel">
            <h2>Settlement rails</h2>
            <div className="admin-rows">
              {metrics.jobs.bySettlementAsset.map((row) => (
                <div key={row.asset}>
                  <span>{String(row.asset).toUpperCase()}</span>
                  <b>{number(row.count)} jobs</b>
                </div>
              ))}
            </div>
          </section>
          <section className="admin-panel">
            <h2>System snapshot</h2>
            <div className="admin-rows">
              <div>
                <span>Invoices</span>
                <b>{number(metrics.invoices)}</b>
              </div>
              <div>
                <span>Updated</span>
                <b>{new Date(metrics.generatedAt).toLocaleTimeString()}</b>
              </div>
            </div>
          </section>
          <EmailPanel token={token} />
        </div>
      </div>
    </main>
  );
}

function EmailPanel({ token }) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async (event) => {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      await request("/v1/admin/email", {
        method: "POST",
        token,
        body: JSON.stringify({ to, subject, text }),
      });
      setStatus("Email sent from team@liegeagents.com.");
      setSubject("");
      setText("");
    } catch (cause) {
      setStatus(cause.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-panel admin-email-panel">
      <h2>
        <Mail size={15} /> Send email
      </h2>
      <p className="admin-panel-note">Send plain-text mail from team@liegeagents.com.</p>
      <form className="admin-email-form" onSubmit={send}>
        <label htmlFor="admin-email-to">Recipient</label>
        <input
          id="admin-email-to"
          type="email"
          required
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="recipient@example.com"
        />
        <label htmlFor="admin-email-subject">Subject</label>
        <input
          id="admin-email-subject"
          required
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
          placeholder="A note from Liege"
        />
        <label htmlFor="admin-email-text">Message</label>
        <textarea
          id="admin-email-text"
          required
          rows={5}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Write your message…"
        />
        <button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send email"}
        </button>
        {status && (
          <div className="admin-email-status" role="status">
            {status}
          </div>
        )}
      </form>
    </section>
  );
}

export default function AdminPage() {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem(tokenKey);
    } catch {
      return null;
    }
  });
  const logout = () => {
    localStorage.removeItem(tokenKey);
    setToken(null);
  };
  const login = (value) => {
    localStorage.setItem(tokenKey, value);
    setToken(value);
  };
  return token ? <Dashboard token={token} onLogout={logout} /> : <Login onLogin={login} />;
}
