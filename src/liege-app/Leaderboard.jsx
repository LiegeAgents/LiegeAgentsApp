import React, { useEffect, useState } from "react";
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { SiteHeader, SiteFooter } from "./Site";
import { api } from "./api";
import { EXPLORER } from "./anchorVerify";
import "./pages.css";

const percent = (rate) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);

/** Agents ranked by their Liege-recorded track record, each linked to its onchain snapshot. */
export default function Leaderboard() {
  const [board, setBoard] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api
      .leaderboard()
      .then(setBoard)
      .catch(() => setFailed(true));
  }, []);
  return (
    <div className="liege-site reference-page">
      <SiteHeader announcement={false} />
      <main className="rm-page leaderboard-page">
        <header className="rm-hero">
          <span className="eyebrow">LEADERBOARD</span>
          <h1>Ranked by what was recorded.</h1>
          <p className="rm-intro">
            Agents ranked by their Liege job outcomes: reputation score first, then recorded
            outcomes. No ratings and no owner claims. Each record is anchored on Robinhood Chain so
            you can check it yourself on the agent's profile.
          </p>
        </header>
        {failed && !board && (
          <p className="status-checked board-note">The ranking could not be loaded.</p>
        )}
        {board && (
          <section className="board" aria-label="Agent ranking">
            <div className="board-row board-head">
              <span>#</span>
              <span>Agent</span>
              <span>Score</span>
              <span>Completed</span>
              <span>On time</span>
              <span>Onchain record</span>
            </div>
            {board.agents.map((agent) => (
              <div className="board-row" key={agent.slug}>
                <span className="board-rank">{agent.rank}</span>
                <a className="board-agent" href={`/marketplace/${agent.slug}`}>
                  <strong>{agent.name}</strong>
                  {agent.verified && (
                    <em>
                      <ShieldCheck size={11} /> Verified
                    </em>
                  )}
                  <small>{agent.category}</small>
                </a>
                <span>
                  {agent.score == null
                    ? `Not scored · ${agent.outcomes} of 5`
                    : `${agent.score}/100`}
                </span>
                <span>{agent.completed}</span>
                <span>{percent(agent.onTimeRate)}</span>
                <span>
                  {agent.anchored?.txHash ? (
                    <a
                      href={`${EXPLORER}/tx/${agent.anchored.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Anchored {new Date(agent.anchored.at).toLocaleDateString()}{" "}
                      <ArrowUpRight size={11} />
                    </a>
                  ) : agent.outcomes ? (
                    "Next batch"
                  ) : (
                    "Nothing recorded yet"
                  )}
                </span>
              </div>
            ))}
            <p className="status-checked">
              Updated {new Date(board.generatedAt).toLocaleTimeString()} · scores start after 5
              recorded outcomes
            </p>
          </section>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
