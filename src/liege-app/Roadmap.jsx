import React, { useEffect } from "react";
import { ArrowRight, ArrowUpRight, ShieldCheck } from "lucide-react";
import { SiteHeader, SiteFooter } from "./Site";
import { Button } from "./UI";
import { roadmap } from "./roadmapContent";
import "./pages.css";

export default function Roadmap() {
  // The page renders client-side, after the browser's own jump to a #phase has been missed.
  useEffect(() => {
    if (location.hash)
      requestAnimationFrame(() =>
        document.getElementById(location.hash.slice(1))?.scrollIntoView(),
      );
  }, []);
  return (
    <div className="liege-site reference-page">
      <SiteHeader announcement={false} />
      <main className="rm-page">
        <header className="rm-hero">
          <span className="eyebrow">ROADMAP</span>
          <h1>The work, in order.</h1>
          <p className="rm-intro">{roadmap.intro}</p>
          <nav className="rm-phase-nav" aria-label="Roadmap phases">
            {roadmap.phases.map((phase, index) => (
              <a href={"#" + phase.id} key={phase.id}>
                <span>{phase.number || `0${index + 1}`}</span>
                {phase.label}
              </a>
            ))}
          </nav>
        </header>
        <ol className="rm-phases">
          {roadmap.phases.map((phase, index) => (
            <li
              id={phase.id}
              key={phase.id}
              className={"rm-phase" + (phase.current ? " is-current" : "")}
            >
              <div className="rm-phase-head">
                <div className="rm-phase-sticky">
                  <div className="rm-phase-marker">
                    <span className="rm-index">{phase.number || `0${index + 1}`}</span>
                    <span className="page-chip">{phase.chip}</span>
                  </div>
                  <h2>{phase.label}</h2>
                  <p className="rm-focus">{phase.focus}</p>
                  <p className="rm-summary">{phase.summary}</p>
                </div>
              </div>
              <ul className="rm-items">
                {phase.items.map((item) => (
                  <li className="rm-item" key={item.title}>
                    <h3>{item.title}</h3>
                    <p>{item.body}</p>
                    {item.href && (
                      <a href={item.href}>
                        {item.link}
                        <ArrowRight size={13} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        <aside className="rm-gate">
          <ShieldCheck size={20} />
          <div>
            <h2>{roadmap.gate.title}</h2>
            <p>{roadmap.gate.body}</p>
            <a href={roadmap.gate.href}>
              {roadmap.gate.link}
              <ArrowRight size={13} />
            </a>
          </div>
        </aside>
        <section className="rm-cta">
          <div>
            <h2>How it fits together.</h2>
            <p>
              The whitepaper describes the protocol behind each phase, and marks what is built and
              what is designed.
            </p>
          </div>
          <div className="rm-cta-actions">
            <Button href="/whitepaper">
              Read the whitepaper <ArrowUpRight size={14} />
            </Button>
            <Button secondary href="/docs/status">
              Product status
            </Button>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
