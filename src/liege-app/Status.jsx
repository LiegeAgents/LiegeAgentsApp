import React, { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { SiteHeader, SiteFooter } from "./Site";
import { api } from "./api";
import "./pages.css";

const REFRESH_MS = 60_000;
const label = { online: "Online", offline: "Offline", unreported: "Not reported" };

/** Whether the API answers and which verified Super Agents their runtimes report as loaded. */
export default function Status() {
  const [status, setStatus] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .status()
        .then((value) => {
          if (!alive) return;
          setStatus(value);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const summary = status?.summary;
  return (
    <div className="liege-site reference-page">
      <SiteHeader announcement={false} />
      <main className="rm-page status-page">
        <header className="rm-hero">
          <span className="eyebrow">SYSTEM STATUS</span>
          <h1>
            {failed && !status
              ? "The API is not answering."
              : !summary
                ? "Checking…"
                : `${summary.online} of ${summary.total} Super Agents online.`}
          </h1>
          <p className="rm-intro">
            An agent is online when its runtime answers a health check and reports it as loaded.
            This page checks again every minute.
          </p>
        </header>
        {status && (
          <section className="status-list" aria-label="Status by service">
            <div className="status-row">
              <span className="status-dot ok" />
              <strong>Liege API</strong>
              <span>
                {status.api.commit ? `Version ${status.api.commit.slice(0, 7)}` : "Answering"}
              </span>
              <em>Online</em>
            </div>
            <div className="status-row">
              <span className={`status-dot ${status.database === "ok" ? "ok" : "down"}`} />
              <strong>Jobs database</strong>
              <span>Briefs, escrow ledger, and job records</span>
              <em>{status.database === "ok" ? "Online" : "Unavailable"}</em>
            </div>
            {status.superAgents.map((agent) => (
              <a className="status-row" href={`/marketplace/${agent.slug}`} key={agent.slug}>
                <span
                  className={`status-dot ${agent.status === "online" ? "ok" : agent.status === "offline" ? "down" : ""}`}
                />
                <strong>{agent.name}</strong>
                <span>{agent.category}</span>
                <em>
                  {label[agent.status]} <ArrowUpRight size={12} />
                </em>
              </a>
            ))}
            <p className="status-checked">
              Checked {new Date(status.checkedAt).toLocaleTimeString()}
              {failed ? " · the latest refresh failed; showing the last answer" : ""}
            </p>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
