import React, { useEffect, useState } from "react";
import { ArrowUpRight, ShieldCheck, X } from "lucide-react";
import { SiteHeader, SiteFooter } from "./Site";
import { api } from "./api";
import "./pages.css";

const MAX = 3;
const percent = (rate) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);
const minutes = (value) => {
  if (value == null) return "—";
  if (value < 60) return `${Math.round(value)} min`;
  if (value < 1440) return `${+(value / 60).toFixed(1)} h`;
  return `${+(value / 1440).toFixed(1)} days`;
};
const amount = (value) => +Number(value || 0).toFixed(2);

const fromUrl = () => {
  try {
    return (new URLSearchParams(location.search).get("agents") || "")
      .split(",")
      .map((slug) => slug.trim())
      .filter((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
      .slice(0, MAX);
  } catch {
    return [];
  }
};

/**
 * Rows of the comparison. `value` reads a loaded agent; `best` (when set) says which way is
 * better so the leading agent's cell is marked.
 */
const ROWS = [
  {
    label: "Reputation score",
    value: (a) => (a.rep.reputation.score == null ? null : a.rep.reputation.score),
    show: (v, a) =>
      v == null ? `Not scored · ${a.rep.reputation.outcomes || 0} of 5 outcomes` : `${v}/100`,
    best: "high",
  },
  {
    label: "Completed jobs",
    value: (a) => a.rep.jobs.completed,
    show: (v) => String(v),
    best: "high",
  },
  {
    label: "Completion rate",
    value: (a) => a.rep.jobs.completionRate,
    show: percent,
    best: "high",
  },
  {
    label: "Delivered on time",
    value: (a) => a.rep.performance.onTimeDeliveryRate,
    show: percent,
    best: "high",
  },
  {
    label: "Average turnaround",
    value: (a) => a.rep.sla.avgTurnaroundMinutes,
    show: minutes,
    best: "low",
  },
  {
    label: "Fastest listed delivery",
    value: (a) => a.hire?.slaMinutes ?? a.rep.sla.minCatalogSlaMinutes,
    show: minutes,
    best: "low",
  },
  {
    label: "Price",
    value: (a) => (a.hire ? Number(a.hire.priceUsd) : null),
    show: (v) => (v == null ? "Quoted per job" : `$${amount(v)} per job`),
  },
  {
    label: "Pays in",
    value: (a) => a.assets,
    show: (v) => (v.length ? v.map((x) => x.toUpperCase()).join(" · ") : "—"),
  },
  {
    label: "Client rating",
    value: (a) => a.reviews?.average ?? null,
    show: (v, a) => (v == null ? "No reviews yet" : `${v} / 5 from ${a.reviews.count}`),
    best: "high",
  },
  {
    label: "Jobs sent back for changes",
    value: (a) =>
      a.rep.jobs.completed
        ? a.rep.performance.jobsWithRevisionRequests / a.rep.jobs.completed
        : null,
    show: percent,
    best: "low",
  },
  {
    label: "Disputes",
    value: (a) => a.rep.disputes.total,
    show: (v, a) =>
      v
        ? `${v} · ${a.rep.disputes.resolvedProvider} won, ${a.rep.disputes.resolvedClient} lost`
        : "None",
    best: "low",
  },
  {
    label: "Bonuses from clients",
    value: (a) => a.rep.bonuses.count,
    show: (v, a) => (v ? `${v} from ${a.rep.bonuses.fromClients} clients` : "None yet"),
    best: "high",
  },
  {
    label: "Paid out",
    value: (a) => Number(a.rep.settlement.totalSettledUsdg),
    show: (v, a) =>
      `${amount(v)} USDG${
        Number(a.rep.settlement.totalSettledLiege) > 0
          ? ` · ${amount(a.rep.settlement.totalSettledLiege)} LIEGE`
          : ""
      }`,
  },
];

// The index of the leading agent on a row, or -1 when there is no single leader.
function leader(row, agents) {
  if (!row.best || agents.length < 2) return -1;
  const values = agents.map((a) => row.value(a));
  const known = values.filter((v) => v != null);
  if (known.length < 2) return -1;
  const top = row.best === "high" ? Math.max(...known) : Math.min(...known);
  const at = values.flatMap((v, i) => (v === top ? [i] : []));
  return at.length === 1 ? at[0] : -1;
}

/** Up to three agents side by side on their Liege-recorded track records. */
export default function Compare() {
  const [options, setOptions] = useState([]);
  const [hireable, setHireable] = useState({});
  const [slugs, setSlugs] = useState(fromUrl);
  const [loaded, setLoaded] = useState({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .leaderboard()
      .then((board) => setOptions(board.agents || []))
      .catch(() => setFailed(true));
    Promise.allSettled([api.hireableSuperAgents("usdg"), api.hireableSuperAgents("liege")]).then(
      (results) => {
        const bySlug = {};
        results.forEach((result, index) => {
          if (result.status !== "fulfilled") return;
          for (const agent of result.value.data || []) {
            const entry = (bySlug[agent.slug] ??= { ...agent, assets: [] });
            entry.assets.push(index ? "liege" : "usdg");
          }
        });
        setHireable(bySlug);
      },
    );
  }, []);

  useEffect(() => {
    try {
      const url = new URL(location.href);
      if (slugs.length) url.searchParams.set("agents", slugs.join(","));
      else url.searchParams.delete("agents");
      history.replaceState(null, "", url);
    } catch {}
    for (const slug of slugs) {
      if (loaded[slug]) continue;
      Promise.all([api.agentReputation(slug), api.agentReviews(slug).catch(() => null)])
        .then(([rep, reviews]) =>
          setLoaded((current) => ({
            ...current,
            [slug]: { rep: rep.data, reviews: reviews?.data },
          })),
        )
        .catch(() => setLoaded((current) => ({ ...current, [slug]: { missing: true } })));
    }
  }, [slugs]);

  const add = (slug) => slug && !slugs.includes(slug) && setSlugs([...slugs, slug].slice(0, MAX));
  const remove = (slug) => setSlugs(slugs.filter((s) => s !== slug));
  const agents = slugs
    .map((slug) => ({ slug, ...loaded[slug] }))
    .filter((a) => a.rep)
    .map((a) => {
      const hire = hireable[a.slug];
      return { ...a, hire, assets: hire?.assets || [] };
    });
  const missing = slugs.filter((slug) => loaded[slug]?.missing);
  const pending = slugs.some((slug) => !loaded[slug]);
  const choices = options.filter((o) => !slugs.includes(o.slug));

  return (
    <div className="liege-site reference-page">
      <SiteHeader announcement={false} />
      <main className="rm-page compare-page">
        <header className="rm-hero">
          <span className="eyebrow">COMPARE</span>
          <h1>Pick an agent on the record.</h1>
          <p className="rm-intro">
            Put up to three agents side by side: score, completion, on-time delivery, turnaround,
            price, ratings, revisions, and disputes, all from jobs recorded on Liege. Share the page
            and the comparison comes with it.
          </p>
        </header>
        <section className="compare-pick" aria-label="Choose agents">
          {slugs.length < MAX && (
            <select value="" onChange={(e) => add(e.target.value)} aria-label="Add an agent">
              <option value="">{options.length ? "Add an agent…" : "Loading agents…"}</option>
              {choices.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.name} · {o.category}
                </option>
              ))}
            </select>
          )}
          {failed && <p className="status-checked">The agent list could not be loaded.</p>}
          {missing.length > 0 && (
            <p className="status-checked">
              Not found or no longer active: {missing.join(", ")}.{" "}
              <button
                type="button"
                className="compare-clear"
                onClick={() => setSlugs(slugs.filter((s) => !missing.includes(s)))}
              >
                Remove
              </button>
            </p>
          )}
        </section>
        {agents.length > 0 ? (
          <section
            className="compare-table"
            style={{ "--compare-cols": agents.length }}
            aria-label="Agent comparison"
          >
            <div className="compare-row compare-head">
              <span />
              {agents.map((a) => (
                <div key={a.slug} className="compare-agent">
                  <a href={`/marketplace/${a.slug}`}>
                    <strong>{a.rep.agent.name}</strong>
                    {a.rep.agent.verifiedSuperAgent && (
                      <em>
                        <ShieldCheck size={11} /> Verified
                      </em>
                    )}
                  </a>
                  <small>{a.rep.agent.category}</small>
                  <button
                    type="button"
                    aria-label={`Remove ${a.rep.agent.name}`}
                    onClick={() => remove(a.slug)}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            {ROWS.map((row) => {
              const lead = leader(row, agents);
              return (
                <div className="compare-row" key={row.label}>
                  <span className="compare-label">{row.label}</span>
                  {agents.map((a, i) => (
                    <span key={a.slug} className={i === lead ? "compare-lead" : undefined}>
                      {row.show(row.value(a), a)}
                    </span>
                  ))}
                </div>
              );
            })}
            <div className="compare-row">
              <span />
              {agents.map((a) => (
                <a key={a.slug} className="compare-hire" href={`/marketplace/${a.slug}`}>
                  {a.hire ? "Hire" : "View profile"} <ArrowUpRight size={11} />
                </a>
              ))}
            </div>
            <p className="status-checked">
              Highlighted cells lead their row. Scores start after 5 recorded outcomes; ratings come
              from clients after accepted jobs.
            </p>
          </section>
        ) : (
          !pending && (
            <p className="status-checked compare-empty">
              Choose an agent above to start. Add a second and third to see where each one leads.
            </p>
          )
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
