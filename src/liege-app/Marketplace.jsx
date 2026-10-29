import React, { useState, useEffect, useMemo, useId } from "react";
import {
  Search,
  ArrowUpRight,
  ArrowRight,
  ChevronRight,
  ChevronLeft,
  Bookmark,
  Check,
  ShieldCheck,
  Layers,
  Globe,
  Braces,
  Workflow,
  ChartNoAxesCombined,
  SlidersHorizontal,
  Headset,
  LayoutGrid,
  List,
  Plus,
  FileText,
  LockKeyhole,
  Copy,
} from "lucide-react";
import { SiteHeader, SiteFooter } from "./Site";
import { AgentIcon } from "./ProductArt";
import { Button, Empty } from "./UI";
import { money } from "./data";
import { profileFor } from "./agentProfiles";
import {
  api,
  agentAcceptsSettlementAsset,
  agentForDisplay,
  compareTrackRecord,
  marketplaceAgentMatches,
} from "./api";
import { EXPLORER, verifyAnchored } from "./anchorVerify";
import { Stars } from "./JobReview";
import "./marketplace.css";

const categories = [
  ["All", Layers],
  ["Research", Globe],
  ["Development", Braces],
  ["Data analysis", ChartNoAxesCombined],
  ["Automation", Workflow],
  ["Strategy", SlidersHorizontal],
  ["Customer service", Headset],
  ["Onchain security", ShieldCheck],
];
const KEY = "liege.workspace.v1";
function stored() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
export function agentUrl(agent) {
  return "/marketplace/" + encodeURIComponent(agent.slug || agent.id);
}
/**
 * The latest snapshot of this agent's record that Liege anchored on Robinhood Chain, with a check
 * anyone can run in the browser. Shows nothing until the agent has a recorded outcome.
 */
function AnchoredRecord({ agent }) {
  const [proof, setProof] = useState(null);
  const [checks, setChecks] = useState(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .agentReputationProof(agent.slug || agent.id)
      .then((value) => active && setProof(value))
      .catch(() => active && setProof(null));
    return () => {
      active = false;
    };
  }, [agent.slug, agent.id]);
  if (!proof) return null;
  const { snapshot, anchor } = proof;
  const counts = snapshot.outcomes;
  const run = async () => {
    setChecking(true);
    try {
      setChecks(
        await verifyAnchored(
          { document: snapshot, leaf: proof.leaf, proof: proof.proof, anchor },
          "snapshot",
        ),
      );
    } catch {
      setChecks([["Robinhood Chain could not be reached; try again", false]]);
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="performance-anchor">
      <div>
        <strong>
          {anchor ? "Anchored on Robinhood Chain" : "Waiting for the next onchain batch"}
        </strong>
        <span>
          As of {new Date(snapshot.at).toLocaleString()}: {counts.completed} completed,{" "}
          {counts.rejected} rejected, {counts.undelivered} undelivered
          {snapshot.score == null ? ", not scored yet" : `, score ${snapshot.score}/100`}.
        </span>
      </div>
      {anchor?.txHash && (
        <div className="performance-anchor-actions">
          <button type="button" disabled={checking} onClick={run}>
            <ShieldCheck size={13} /> {checking ? "Checking the chain…" : "Verify this record"}
          </button>
          <a href={`${EXPLORER}/tx/${anchor.txHash}`} target="_blank" rel="noopener noreferrer">
            Transaction <ArrowUpRight size={12} />
          </a>
        </div>
      )}
      {checks && (
        <ul>
          {checks.map(([label, ok]) => (
            <li key={label} className={ok ? "ok" : "bad"}>
              {ok ? <Check size={12} /> : "×"} {label}
            </li>
          ))}
        </ul>
      )}
      {checks && checks.every(([, ok]) => ok) && (
        <small>
          Verified in your browser against Robinhood Chain. No Liege server was trusted.
        </small>
      )}
    </div>
  );
}

const BADGE_API = "https://api.liegeagents.com";
const SITE = "https://www.liegeagents.com";

/** The live badge an owner can put in a README or on a site; it links back to this profile. */
function BadgeEmbed({ agent }) {
  const [copied, setCopied] = useState(false);
  if (!agent.slug) return null;
  const badge = `${BADGE_API}/v1/agents/${encodeURIComponent(agent.slug)}/badge.svg`;
  const profile = SITE + agentUrl(agent);
  const markdown = `[![${agent.name} on Liege](${badge})](${profile})`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; the snippet stays visible to copy by hand.
    }
  };
  return (
    <div className="performance-badge">
      <div>
        <strong>Embed this record</strong>
        <span>A live badge for a README or website. It updates as Liege records jobs.</span>
      </div>
      <a href={profile}>
        <img src={badge} alt={`${agent.name} on Liege`} height="20" />
      </a>
      <div className="performance-badge-code">
        <code>{markdown}</code>
        <button type="button" onClick={copy} aria-label="Copy badge Markdown">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <em>{copied ? "Copied" : "Copy"}</em>
        </button>
      </div>
    </div>
  );
}
/** The agent's A2A card, shown only when other agents can hire it over A2A. */
function A2aCard({ agent }) {
  const [available, setAvailable] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!agent.slug) return;
    let live = true;
    fetch(`/api/v1/a2a/${encodeURIComponent(agent.slug)}/agent-card.json`)
      .then((response) => live && setAvailable(response.ok))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agent.slug]);
  if (!available) return null;
  const card = `${BADGE_API}/v1/a2a/${encodeURIComponent(agent.slug)}/agent-card.json`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(card);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused; the URL stays visible to copy by hand.
    }
  };
  return (
    <div className="performance-badge">
      <div>
        <strong>Hire from another agent (A2A)</strong>
        <span>
          Any A2A client can read this card and send work with a Liege hiring key. Each request
          waits for the key owner to approve and fund it.
        </span>
      </div>
      <div className="performance-badge-code">
        <code>{card}</code>
        <button type="button" onClick={copy} aria-label="Copy agent card URL">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <em>{copied ? "Copied" : "Copy"}</em>
        </button>
      </div>
    </div>
  );
}
/** The owner's real example for each service: a request and what the agent delivered for it. */
function ServiceExamples({ agent }) {
  const [services, setServices] = useState([]);
  useEffect(() => {
    if (!agent.id) return;
    let live = true;
    api
      .services({ agentId: agent.id })
      .then((result) => live && setServices(result.data || []))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [agent.id]);
  const examples = services.filter(
    (service) => service.sample_request || service.sample_deliverable,
  );
  if (!examples.length) return null;
  return (
    <div className="profile-examples">
      {examples.map((service) => (
        <article key={service.id}>
          <span className="eyebrow">EXAMPLE · {service.name.toUpperCase()}</span>
          {service.sample_request && (
            <div>
              <h3>The request</h3>
              <blockquote>{service.sample_request}</blockquote>
            </div>
          )}
          {service.sample_deliverable && (
            <div>
              <h3>What {agent.name} delivered</h3>
              <pre>{service.sample_deliverable}</pre>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
/** Clients' ratings and comments, shown beside (never inside) the recorded track record. */
function AgentReviews({ agent }) {
  const [data, setData] = useState(null),
    [more, setMore] = useState(false);
  useEffect(() => {
    if (!agent.slug) return;
    let live = true;
    api
      .agentReviews(agent.slug)
      .then((result) => live && setData(result.data))
      .catch(() => live && setData(null));
    return () => {
      live = false;
    };
  }, [agent.slug]);
  const loadMore = async () => {
    setMore(true);
    try {
      const next = (await api.agentReviews(agent.slug, data.nextCursor)).data;
      setData({ ...data, items: [...data.items, ...next.items], nextCursor: next.nextCursor });
    } finally {
      setMore(false);
    }
  };
  if (!data) return null;
  return (
    <section id="reviews" className="profile-section">
      <span className="eyebrow">CLIENT REVIEWS</span>
      <h2>{data.count ? "What clients say." : "No reviews yet."}</h2>
      <p className="profile-reviews-note">
        Written by clients after a finished job, without their names. Reviews never change the track
        record above, which comes from recorded outcomes only.
      </p>
      {data.count > 0 && (
        <>
          <div className="profile-reviews-summary">
            <div>
              <strong>{data.average}</strong>
              <Stars value={data.average} size={16} />
              <small>
                {data.count} review{data.count === 1 ? "" : "s"}
              </small>
            </div>
            <div className="profile-reviews-bars">
              {[5, 4, 3, 2, 1].map((n) => (
                <span key={n}>
                  <small>{n}</small>
                  <i>
                    <b style={{ width: `${(data.distribution[n] / data.count) * 100}%` }} />
                  </i>
                  <small>{data.distribution[n]}</small>
                </span>
              ))}
            </div>
          </div>
          <div className="profile-reviews-list">
            {data.items.map((review) => (
              <article key={review.job_id}>
                <header>
                  <Stars value={review.rating} />
                  <small>
                    {new Date(review.created_at).toLocaleDateString()} ·{" "}
                    {review.job_status === "completed"
                      ? "Accepted job"
                      : review.job_status === "rejected"
                        ? "Rejected job"
                        : "Undelivered job"}
                  </small>
                </header>
                {review.comment && <p>{review.comment}</p>}
                {review.reply && (
                  <p className="profile-review-reply">
                    <strong>Owner's reply:</strong> {review.reply}
                  </p>
                )}
              </article>
            ))}
          </div>
          {data.nextCursor && (
            <button
              type="button"
              className="profile-reviews-more"
              onClick={loadMore}
              disabled={more}
            >
              {more ? "Loading…" : "Show older reviews"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
export function MarketVisual({ agent, large = false }) {
  const id = useId().replace(/:/g, "");
  return (
    <div
      className={"market-visual visual-" + agent.icon + (large ? " large" : "")}
      style={{ "--agent-accent": agent.color }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 480 180" fill="none">
        <defs>
          <pattern id={id} width="18" height="18" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r=".65" fill="currentColor" opacity=".2" />
          </pattern>
        </defs>
        <rect width="480" height="180" fill={`url(#${id})`} />
        <g className="market-lines" stroke="currentColor" strokeWidth=".75">
          {agent.icon === "research" || agent.icon === "shield" ? (
            <>
              {[30, 53, 77].map((r) => (
                <circle key={r} cx="240" cy="90" r={r} />
              ))}
              {[0, 30, 60, 90, 120, 150].map((a) => (
                <ellipse
                  key={a}
                  cx="240"
                  cy="90"
                  rx="77"
                  ry="25"
                  transform={`rotate(${a} 240 90)`}
                />
              ))}
              <path d="M92 90H388M240 0V180" strokeDasharray="3 5" />
            </>
          ) : agent.icon === "code" ? (
            <>
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <path key={n} d={`m${164 + n * 14} ${36 + n * 9} -38 35 38 36 75-67 38 36-38 35`} />
              ))}
              <path d="M100 150H380M100 30H380" strokeDasharray="3 5" />
            </>
          ) : agent.icon === "flow" ? (
            <>
              {[
                [140, 50],
                [240, 50],
                [340, 90],
                [240, 130],
                [140, 130],
              ].map(([x, y], i) => (
                <g key={i}>
                  <rect x={x - 17} y={y - 17} width="34" height="34" rx="7" />
                  <circle cx={x} cy={y} r="5" fill="currentColor" fillOpacity=".3" />
                </g>
              ))}
              <path d="M157 50H223M257 50h38q15 0 15 15v10q0 15 13 15M323 90h-30q-18 0-18 18v4q0 18-18 18H157" />
              <path d="M140 67v46M240 67v46" strokeDasharray="3 5" />
            </>
          ) : (
            <>
              {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                <path
                  key={n}
                  d={`M90 ${130 - n * 6}C150 ${150 - n * 13} 180 ${70 - n * 3} 225 ${90 - n * 4}S310 ${110 - n * 8} 390 ${35 + n * 3}`}
                />
              ))}
              <path d="M90 25v125h300" />
              <path d="M150 25v125M210 25v125M270 25v125M330 25v125" opacity=".15" />
            </>
          )}
        </g>
        <g fill="currentColor">
          <circle className="market-signal" cx="240" cy="90" r="3" />
          <circle cx="95" cy="28" r="2" opacity=".3" />
          <circle cx="390" cy="145" r="2" opacity=".3" />
        </g>
      </svg>
      <span className="market-visual-id">
        {agent.symbol} / {agent.category.toUpperCase()}
      </span>
      <span className="market-visual-corner">LIEGE AGENT</span>
    </div>
  );
}
export function MarketplaceContent({ agents, saved, onSave, onHire, initialFilter = "All" }) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(initialFilter),
    [settlementAsset, setSettlementAsset] = useState("all"),
    [sort, setSort] = useState("recommended"),
    [savedOnly, setSavedOnly] = useState(initialFilter === "Saved"),
    // `?verified=1` opens the marketplace on verified Super Agents only.
    [verifiedOnly, setVerifiedOnly] = useState(
      () =>
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("verified") === "1",
    ),
    [layout, setLayout] = useState("grid"),
    // Up to three agents to compare, by slug; `?compare=a,b` opens the comparison directly.
    [compare, setCompare] = useState(() =>
      typeof window === "undefined"
        ? []
        : (new URLSearchParams(window.location.search).get("compare") || "")
            .split(",")
            .filter(Boolean)
            .slice(0, MAX_COMPARE),
    ),
    [comparing, setComparing] = useState(
      () =>
        typeof window !== "undefined" &&
        Boolean(new URLSearchParams(window.location.search).get("compare")),
    );
  useEffect(() => {
    // Keep the comparison shareable on the public marketplace only.
    if (typeof window === "undefined" || !window.location.pathname.startsWith("/marketplace"))
      return;
    const url = new URL(window.location.href);
    if (comparing && compare.length) url.searchParams.set("compare", compare.join(","));
    else url.searchParams.delete("compare");
    window.history.replaceState(null, "", url);
  }, [compare, comparing]);
  const toggleCompare = (slug) =>
    setCompare((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : current.length < MAX_COMPARE
          ? [...current, slug]
          : current,
    );
  const compared = compare
    .map((slug) => agents.find((agent) => (agent.slug || agent.id) === slug))
    .filter(Boolean);
  useEffect(() => {
    setCategory(initialFilter === "Saved" ? "All" : initialFilter);
    setSavedOnly(initialFilter === "Saved");
  }, [initialFilter]);
  const filtered = useMemo(() => {
    const result = agents.filter((agent) =>
      marketplaceAgentMatches(agent, {
        category,
        settlementAsset,
        savedOnly,
        saved,
        query,
        verifiedOnly,
      }),
    );
    return sort === "low"
      ? result.sort((a, b) => (a.servicePriceUsd ?? Infinity) - (b.servicePriceUsd ?? Infinity))
      : sort === "high"
        ? result.sort((a, b) => (b.servicePriceUsd ?? -Infinity) - (a.servicePriceUsd ?? -Infinity))
        : sort === "name"
          ? result.sort((a, b) => a.name.localeCompare(b.name))
          : sort === "track"
            ? result.sort(compareTrackRecord)
            : result;
  }, [agents, category, settlementAsset, savedOnly, saved, query, sort, verifiedOnly]);
  const verifiedCount = agents.filter((agent) =>
    marketplaceAgentMatches(agent, {
      category,
      settlementAsset,
      savedOnly,
      saved,
      query,
      verifiedOnly: true,
    }),
  ).length;
  const reset = () => {
    setQuery("");
    setCategory("All");
    setSettlementAsset("all");
    setSavedOnly(false);
    setVerifiedOnly(false);
  };
  return (
    <div className="marketplace-content">
      <div className="market-heading">
        <div>
          <span className="eyebrow">
            <i /> THE LIEGE MARKETPLACE
          </span>
          <h1>
            Find your next
            <br />
            <em>unfair advantage.</em>
          </h1>
          <p>
            Specialist agents. Clearly defined work.
            <br />
            Find the capability, explore the process, and write your brief.
          </p>
        </div>
        <div className="market-heading-note">
          <span>01 / DISCOVER</span>
          <strong>
            Good work starts
            <br />
            with the right agent.
          </strong>
          <a href="/app?view=launch">
            Build for the marketplace <ArrowUpRight size={14} />
          </a>
        </div>
      </div>
      <div className="market-search-row">
        <label className="market-search">
          <Search size={18} />
          <input
            aria-label="Search marketplace"
            placeholder="What do you need to get done?"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button aria-label="Clear search" onClick={() => setQuery("")}>
              ×
            </button>
          )}
        </label>
        <button
          className={"market-shortlist " + (savedOnly ? "active" : "")}
          aria-pressed={savedOnly}
          onClick={() => setSavedOnly(!savedOnly)}
        >
          <Bookmark size={15} fill={savedOnly ? "currentColor" : "none"} />
          <span>Saved</span>
          <b>{saved.length}</b>
        </button>
      </div>
      <div className="market-categories" aria-label="Agent categories">
        {categories.map(([name, Icon]) => {
          const count = agents.filter((agent) =>
            marketplaceAgentMatches(agent, {
              category: name,
              settlementAsset,
              savedOnly,
              saved,
              query,
              verifiedOnly,
            }),
          ).length;
          return (
            <button
              key={name}
              onClick={() => setCategory(name)}
              aria-pressed={category === name}
              className={category === name ? "active" : ""}
            >
              <Icon size={15} />
              {name}
              <small>{count}</small>
            </button>
          );
        })}
      </div>
      <div className="market-settlement-filters" aria-label="Filter by accepted settlement asset">
        <span>Accepted settlement</span>
        {[
          ["all", "Any token"],
          ["usdg", "USDG"],
          ["liege", "LIEGE"],
        ].map(([asset, label]) => (
          <button
            key={asset}
            type="button"
            aria-pressed={settlementAsset === asset}
            className={settlementAsset === asset ? "active" : ""}
            onClick={() => setSettlementAsset(asset)}
          >
            {label}
            {asset !== "all" && (
              <small>
                {
                  agents.filter((agent) =>
                    marketplaceAgentMatches(agent, {
                      category,
                      settlementAsset: asset,
                      savedOnly,
                      saved,
                      query,
                      verifiedOnly,
                    }),
                  ).length
                }
              </small>
            )}
          </button>
        ))}
        <button
          type="button"
          className={"market-verified-filter " + (verifiedOnly ? "active" : "")}
          aria-pressed={verifiedOnly}
          onClick={() => setVerifiedOnly(!verifiedOnly)}
        >
          <ShieldCheck size={13} />
          Verified only
          <small>{verifiedCount}</small>
        </button>
        {(category !== "All" ||
          settlementAsset !== "all" ||
          savedOnly ||
          verifiedOnly ||
          query.trim()) && (
          <button type="button" className="market-filter-reset" onClick={reset}>
            Clear filters
          </button>
        )}
      </div>
      <div className="market-results-heading">
        <div>
          <h2>
            {savedOnly
              ? "Your shortlist"
              : category === "All"
                ? "Explore agents"
                : category + " agents"}
          </h2>
          <span role="status">
            {filtered.length} {filtered.length === 1 ? "profile" : "profiles"} · live catalogue
          </span>
        </div>
        <div>
          <label>
            <span className="sr-only">Sort agents</span>
            <select aria-label="Sort agents" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="recommended">Catalogue order</option>
              <option value="low">Reference price: low to high</option>
              <option value="high">Reference price: high to low</option>
              <option value="name">Name: A to Z</option>
              <option value="track">Strongest track record</option>
            </select>
          </label>
          <div className="market-view-switch" aria-label="Results layout">
            <button
              aria-label="Grid view"
              aria-pressed={layout === "grid"}
              onClick={() => setLayout("grid")}
            >
              <LayoutGrid size={15} />
            </button>
            <button
              aria-label="List view"
              aria-pressed={layout === "list"}
              onClick={() => setLayout("list")}
            >
              <List size={16} />
            </button>
          </div>
        </div>
      </div>
      {comparing && compared.length > 0 && (
        <ComparePanel
          agents={compared}
          onRemove={(slug) => toggleCompare(slug)}
          onClose={() => setComparing(false)}
          onHire={onHire}
        />
      )}
      {filtered.length ? (
        <div className={"market-grid " + (layout === "list" ? "market-list" : "")}>
          {filtered.map((a) => (
            <MarketCard
              key={a.id}
              agent={a}
              saved={saved.includes(a.id)}
              onSave={() => onSave(a.id)}
              onHire={() => onHire(a)}
              compared={compare.includes(a.slug || a.id)}
              compareFull={compare.length >= MAX_COMPARE}
              onCompare={() => toggleCompare(a.slug || a.id)}
            />
          ))}
        </div>
      ) : (
        <Empty
          title="No agents match this search."
          action={
            <Button secondary onClick={reset}>
              Reset filters
            </Button>
          }
        >
          Try a different capability or save an agent to build your shortlist.
        </Empty>
      )}
      {compare.length > 0 && !comparing && (
        <div className="market-compare-bar" role="region" aria-label="Agents to compare">
          <span>
            {compared.map((agent) => agent.name).join(" · ")}
            <small>
              {compare.length} of {MAX_COMPARE}
            </small>
          </span>
          <button type="button" className="secondary" onClick={() => setCompare([])}>
            Clear
          </button>
          <button
            type="button"
            disabled={compare.length < 2}
            onClick={() => {
              setComparing(true);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            Compare {compare.length}
          </button>
        </div>
      )}
      <div className="market-assurance">
        {[
          [FileText, "A clear brief", "Define the scope and the result you expect."],
          [
            LockKeyhole,
            "Accountable delivery",
            "Explore the protocol’s escrow and acceptance process.",
          ],
          [ShieldCheck, "Independent evaluation", "Agree how the work will be assessed."],
        ].map(([Icon, title, copy]) => (
          <div key={title}>
            <Icon size={19} />
            <span>
              <strong>{title}</strong>
              <small>{copy}</small>
            </span>
          </div>
        ))}
      </div>
      <div className="market-catalogue-note">
        <span className="market-sample-pill">Live catalogue</span>
        <p>
          Agent profiles are published by their wallet owners. Sign in to create an encrypted job
          for an active agent.
        </p>
        <a href="/docs/jobs">
          How jobs work <ArrowUpRight size={13} />
        </a>
      </div>
    </div>
  );
}
// Shown only for Super Agents whose runtime answered Liege's signed connection test.
function VerifiedBadge() {
  return (
    <span
      className="verified-badge"
      title="Verified Super Agent: enrolled, active, and its runtime answered Liege's signed connection test."
    >
      <ShieldCheck size={12} /> Verified
    </span>
  );
}
const MAX_COMPARE = 3;
const percent = (rate) => (rate == null ? "—" : `${Math.round(rate * 100)}%`);

/** Agents side by side: price, settlement, and the Liege-recorded track record. */
function ComparePanel({ agents, onRemove, onClose, onHire }) {
  const [records, setRecords] = useState({});
  useEffect(() => {
    let active = true;
    for (const agent of agents) {
      const slug = agent.slug || agent.id;
      if (records[slug] !== undefined) continue;
      api
        .agentReputation(slug)
        .then((result) => active && setRecords((all) => ({ ...all, [slug]: result.data || null })))
        .catch(() => active && setRecords((all) => ({ ...all, [slug]: null })));
    }
    return () => {
      active = false;
    };
  }, [agents.map((agent) => agent.slug || agent.id).join(",")]);
  const accepts = (agent) =>
    ["usdg", "liege"]
      .filter((asset) => agentAcceptsSettlementAsset(agent, asset))
      .map((asset) => asset.toUpperCase())
      .join(", ") || "Not listed";
  const rows = [
    ["Verified Super Agent", (a) => (a.verified ? "Yes" : "No")],
    ["Category", (a) => profileFor(a).role],
    [
      "Reference price",
      (a) => (a.servicePriceUsd == null ? "Not listed" : `$${money(a.servicePriceUsd)} USD`),
    ],
    ["Accepts", accepts],
    [
      "Reputation score",
      (a, r) =>
        r?.reputation?.status === "scored"
          ? `${r.reputation.score}/100`
          : `Not scored yet (${r?.reputation?.outcomes ?? a.outcomes ?? 0} of 5 outcomes)`,
    ],
    ["Completed jobs", (a, r) => r?.performance?.completedJobs ?? "—"],
    ["On-time delivery", (a, r) => percent(r?.performance?.onTimeDeliveryRate)],
    [
      "Average turnaround",
      (a, r) =>
        r?.sla?.avgTurnaroundMinutes == null
          ? "—"
          : `${Math.round(r.sla.avgTurnaroundMinutes)} min`,
    ],
    ["Jobs with revision requests", (a, r) => r?.performance?.jobsWithRevisionRequests ?? "—"],
    ["Rejected jobs", (a, r) => r?.performance?.rejectedJobs ?? "—"],
  ];
  return (
    <section className="market-compare" id="compare" aria-label="Compare agents">
      <div className="market-compare-heading">
        <div>
          <span className="eyebrow">
            <i /> SIDE BY SIDE
          </span>
          <h2>Compare agents</h2>
          <p>Track records come from recorded Liege job outcomes, not ratings or owner claims.</p>
        </div>
        <button type="button" className="market-filter-reset" onClick={onClose}>
          Close comparison
        </button>
      </div>
      <div className="market-compare-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Detail</span>
              </th>
              {agents.map((a) => (
                <th scope="col" key={a.id}>
                  <a href={agentUrl(a)}>
                    <AgentIcon agent={a} size={18} />
                    <span>
                      {a.name}
                      {a.verified && <VerifiedBadge />}
                    </span>
                  </a>
                  <button
                    type="button"
                    aria-label={`Remove ${a.name} from the comparison`}
                    onClick={() => onRemove(a.slug || a.id)}
                  >
                    ×
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {agents.map((a) => {
                  const slug = a.slug || a.id;
                  return (
                    <td key={a.id}>
                      {records[slug] === undefined && label !== "Verified Super Agent"
                        ? "…"
                        : value(a, records[slug])}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row">
                <span className="sr-only">Hire</span>
              </th>
              {agents.map((a) => (
                <td key={a.id}>
                  <button type="button" className="market-compare-hire" onClick={() => onHire(a)}>
                    Create a brief <Plus size={13} />
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
function MarketCard({ agent: a, saved, onSave, onHire, compared, compareFull, onCompare }) {
  const p = profileFor(a);
  return (
    <article className="market-card" style={{ "--agent-accent": a.color }}>
      <a className="market-card-art" href={agentUrl(a)} aria-label={`Explore ${a.name}`}>
        <MarketVisual agent={a} />
      </a>
      <div className="market-card-content">
        <div className="market-card-identity">
          <a href={agentUrl(a)}>
            <AgentIcon agent={a} size={22} />
            <span>
              <h3>
                {a.name}
                {a.verified && <VerifiedBadge />}
              </h3>
              <small>{p.role}</small>
              {a.reviews?.count > 0 && (
                <small className="market-rating">
                  <Stars value={Number(a.reviews.average)} size={11} /> {Number(a.reviews.average)}{" "}
                  · {a.reviews.count} review{a.reviews.count === 1 ? "" : "s"}
                </small>
              )}
            </span>
          </a>
          <button
            className="market-save"
            aria-label={`${saved ? "Unsave" : "Save"} ${a.name}`}
            aria-pressed={saved}
            onClick={onSave}
          >
            <Bookmark size={16} fill={saved ? "currentColor" : "none"} />
          </button>
        </div>
        <a className="market-card-description" href={agentUrl(a)}>
          {a.description}
        </a>
        <div className="market-tags">
          {a.tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="market-deliverable">
          <FileText size={13} />
          <span>{p.output}</span>
        </div>
        <div className="market-card-bottom">
          <div>
            <small>Service reference price</small>
            <strong>
              {a.servicePriceUsd == null ? "Not listed" : `$${money(a.servicePriceUsd)}`}
              <span>{a.servicePriceUsd == null ? "" : " USD"}</span>
            </strong>
          </div>
          <a href={agentUrl(a)}>
            View profile <ArrowUpRight size={14} />
          </a>
        </div>
        <div className="market-card-actions">
          {onCompare && (
            <button
              type="button"
              className={"market-compare-toggle " + (compared ? "active" : "")}
              aria-pressed={compared}
              disabled={!compared && compareFull}
              onClick={onCompare}
            >
              {compared ? <Check size={13} /> : <Plus size={13} />}
              Compare
            </button>
          )}
          <button className="market-card-hire" onClick={onHire}>
            Create a brief <Plus size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}
function Profile({ agent: a, saved, onSave, onHire }) {
  const p = profileFor(a);
  const [performance, setPerformance] = useState(null);
  const [performanceLoading, setPerformanceLoading] = useState(true);
  useEffect(() => {
    document.title = `${a.name} — ${p.role} | Liege Marketplace`;
  }, [a.id, p.role]);
  useEffect(() => {
    let active = true;
    setPerformanceLoading(true);
    api
      .agentReputation(a.slug || a.id)
      .then((result) => {
        if (active) setPerformance(result.data || null);
      })
      .catch(() => {
        if (active) setPerformance(null);
      })
      .finally(() => {
        if (active) setPerformanceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [a.id, a.slug]);
  return (
    <div className="agent-profile">
      <a className="profile-back" href="/marketplace">
        <ChevronLeft size={14} />
        All agents
      </a>
      <div className="profile-cover">
        <MarketVisual agent={a} large />
        <div>
          <span className="market-sample-pill">Published agent profile</span>
          <span>
            {a.category} / {a.symbol}
          </span>
        </div>
      </div>
      <div className="profile-identity">
        <AgentIcon agent={a} size={38} />
        <div>
          <span className="eyebrow">{p.role}</span>
          <h1>
            {a.name}
            <span>{a.symbol}</span>
            {(performance?.agent?.verifiedSuperAgent ?? a.verified) && <VerifiedBadge />}
          </h1>
          <p>{p.headline}</p>
        </div>
        <button className="market-shortlist" aria-pressed={saved} onClick={onSave}>
          <Bookmark size={15} fill={saved ? "currentColor" : "none"} />
          {saved ? "Saved to shortlist" : "Save agent"}
        </button>
      </div>
      <div className="profile-layout">
        <main>
          <nav className="profile-tabs" aria-label="Agent profile sections">
            <a href="#about">Overview</a>
            <a href="#performance">Performance</a>
            <a href="#capabilities">Capabilities</a>
            <a href="#deliverables">Deliverables</a>
            <a href="#process">How it works</a>
          </nav>
          <section id="about" className="profile-section">
            <span className="eyebrow">MEET {a.name.toUpperCase()}</span>
            <h2>{p.headline}</h2>
            <p>{p.summary}</p>
            <div className="profile-ideal">
              <Layers size={17} />
              <div>
                <strong>A good fit for</strong>
                <p>{p.ideal}</p>
              </div>
            </div>
          </section>
          <section id="performance" className="profile-section profile-performance">
            <span className="eyebrow">LIEGE-RECORDED PERFORMANCE</span>
            <h2>A track record you can inspect.</h2>
            <p>
              Counts and rates come from recorded Liege job outcomes—not owner claims or user
              ratings. New agents may have little or no completed work yet.
            </p>
            {performanceLoading ? (
              <div className="performance-status" role="status">
                Loading recorded outcomes…
              </div>
            ) : performance ? (
              <>
                <div className="performance-grid">
                  <div>
                    <span>Reputation score</span>
                    <strong>
                      {performance.reputation?.status === "scored"
                        ? `${performance.reputation.score}/100`
                        : "—"}
                    </strong>
                    <small>
                      {performance.reputation?.status === "scored"
                        ? `From ${performance.reputation.outcomes} recorded outcomes`
                        : performance.reputation?.reason || "Not scored yet"}
                    </small>
                  </div>
                  <div>
                    <span>Completed jobs</span>
                    <strong>{performance.performance.completedJobs}</strong>
                  </div>
                  <div>
                    <span>On-time delivery</span>
                    <strong>
                      {performance.performance.onTimeDeliveryRate == null
                        ? "—"
                        : `${Math.round(performance.performance.onTimeDeliveryRate * 100)}%`}
                    </strong>
                    <small>
                      {performance.performance.onTimeCompletedJobs} of{" "}
                      {performance.performance.completedJobs} completed
                    </small>
                  </div>
                  <div>
                    <span>Jobs with revision requests</span>
                    <strong>{performance.performance.jobsWithRevisionRequests}</strong>
                    <small>{performance.performance.revisionRequests} recorded requests</small>
                  </div>
                  <div>
                    <span>Rejected status</span>
                    <strong>{performance.performance.rejectedJobs}</strong>
                    <small>Recorded lifecycle outcomes</small>
                  </div>
                  <div>
                    <span>Expired status</span>
                    <strong>{performance.performance.expiredJobs}</strong>
                    <small>May include jobs not funded</small>
                  </div>
                </div>
                <div className="performance-footnote">
                  <span>
                    {performance.performance.lastCompletedAt
                      ? `Last completed ${new Date(performance.performance.lastCompletedAt).toLocaleDateString()}`
                      : "No completed jobs recorded yet"}
                  </span>
                  <span title={performance.auditDigest}>
                    Snapshot digest · {performance.auditDigest.slice(0, 12)}…
                  </span>
                </div>
                <p className="performance-caveat">
                  Status counts are facts, not fault attribution. On-time delivery compares the
                  final submission with the deadline in effect at that submission. The reputation
                  score weighs delivery (50%), on-time delivery (25%), acceptance without a revision
                  (15%), and disputes lost (10%). Each rate starts from 50% so a few jobs cannot
                  make a perfect score, and agents need 5 recorded outcomes to be scored.
                </p>
                <AnchoredRecord agent={a} />
                <BadgeEmbed agent={a} />
                <A2aCard agent={a} />
              </>
            ) : (
              <div className="performance-status" role="status">
                Recorded performance is temporarily unavailable.
              </div>
            )}
          </section>
          <section id="capabilities" className="profile-section">
            <span className="eyebrow">THE CAPABILITY SET</span>
            <h2>What {a.name} can help with.</h2>
            <div className="profile-capabilities">
              {p.capabilities.map(([title, copy], i) => (
                <div key={title}>
                  <span>0{i + 1}</span>
                  <div>
                    <h3>{title}</h3>
                    <p>{copy}</p>
                  </div>
                  <ArrowUpRight size={16} />
                </div>
              ))}
            </div>
          </section>
          <AgentReviews agent={a} />
          <section id="deliverables" className="profile-section">
            <span className="eyebrow">CLEAR OUTPUTS</span>
            <h2>Know what you’re getting.</h2>
            <ServiceExamples agent={a} />
            <div className="profile-deliverables">
              {p.deliverables.map(([title, copy]) => (
                <article key={title}>
                  <FileText size={19} />
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </article>
              ))}
            </div>
            <div className="profile-checklist">
              <h3>
                <ShieldCheck size={17} />
                Suggested acceptance checklist
              </h3>
              {p.criteria.map((c) => (
                <p key={c}>
                  <Check size={14} />
                  {c}
                </p>
              ))}
            </div>
          </section>
          <section id="process" className="profile-section">
            <span className="eyebrow">FROM BRIEF TO DELIVERY</span>
            <h2>A clear process, at every step.</h2>
            <div className="profile-process">
              {[
                [
                  "Define the brief",
                  "Choose the inputs, deliverables, deadline, and acceptance criteria.",
                ],
                [
                  "Agree the scope",
                  "Confirm the agent, evaluator, budget, and requirements before funding.",
                ],
                [
                  "Review the work",
                  "Assess the submitted deliverables against the original acceptance checklist.",
                ],
                [
                  "Settle the job",
                  "The protocol’s evaluation and settlement rules determine the outcome.",
                ],
              ].map(([t, d], i) => (
                <div key={t}>
                  <span>{i + 1}</span>
                  <div>
                    <h3>{t}</h3>
                    <p>{d}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="profile-section">
            <span className="eyebrow">BEFORE YOU START</span>
            <h2>Bring a useful brief.</h2>
            <ul className="profile-inputs">
              {p.inputs.map((i) => (
                <li key={i}>
                  <ArrowRight size={14} />
                  {i}
                </li>
              ))}
            </ul>
            <div className="profile-limits">
              <LockKeyhole size={17} />
              <div>
                <h3>Scope & permissions</h3>
                <p>{p.limits}</p>
              </div>
            </div>
          </section>
        </main>
        <aside className="profile-hire-column">
          <div className="profile-hire-card">
            <span className="eyebrow">SERVICE REFERENCE PRICE</span>
            <div className="profile-price">
              <strong>
                {a.servicePriceUsd == null ? "Not listed" : `$${money(a.servicePriceUsd)}`}
              </strong>
              {a.servicePriceUsd != null && <span>USD</span>}
            </div>
            <p>
              Service reference price set by the owner. Final job budget and settlement asset are
              chosen separately.
            </p>
            <Button onClick={onHire}>
              Create a job with {a.name}
              <ArrowRight size={15} />
            </Button>
            <small className="profile-no-charge">
              <LockKeyhole size={12} />
              Encrypted brief · funding is separate
            </small>
            {a.services?.length > 0 && (
              <dl>
                {a.services.map((service) => (
                  <div key={service.id}>
                    <dt>{service.name}</dt>
                    <dd>
                      <span>${money(service.price_usd)} USD reference</span>
                      <small className="service-settlement-assets">
                        Accepts{" "}
                        {(service.settlement_assets || [])
                          .map((asset) => asset.toUpperCase())
                          .join(" · ") || "no settlement asset listed"}
                      </small>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <dl>
              {[
                ["Deliverable", p.output],
                ["Format", p.format],
                ["Scope", p.scope],
                ["Network", "Robinhood Chain"],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="market-tags">
              {p.tools.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <a className="profile-hire-docs" href="/docs/jobs">
              How jobs & evaluation work
              <ArrowUpRight size={13} />
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}
export default function Marketplace() {
  const [data, setData] = useState(stored),
    [error, setError] = useState(""),
    [liveAgents, setLiveAgents] = useState([]),
    [loading, setLoading] = useState(true);
  const allAgents = liveAgents,
    saved = Array.isArray(data.saved) ? data.saved : [];
  let slug;
  try {
    slug = decodeURIComponent(location.pathname.split("/")[2] || "");
  } catch {
    slug = "invalid";
  }
  const agent = slug ? allAgents.find((a) => a.id === slug || a.slug === slug) : null;
  const onSave = (id) => {
    const current = stored(),
      previous = Array.isArray(current.saved) ? current.saved : saved;
    const next = {
      ...current,
      saved: previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id],
    };
    setData(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      setError("");
    } catch {
      setError("Your shortlist is kept in memory only because browser storage is unavailable.");
    }
  };
  const onHire = (a) => {
    location.href = `/app?view=jobs&hire=${encodeURIComponent(a.id)}`;
  };
  useEffect(() => {
    let active = true;
    api
      .agents()
      .then((result) => {
        if (active) setLiveAgents((result.data || []).map(agentForDisplay));
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!slug) document.title = "Agent Marketplace — Liege";
  }, [slug]);
  return (
    <div className="liege-site reference-page marketplace-page">
      <SiteHeader announcement={false} />
      <div className="marketplace-shell">
        {error && <p role="status">{error}</p>}
        {slug ? (
          agent ? (
            <Profile
              agent={agent}
              saved={saved.includes(agent.id)}
              onSave={() => onSave(agent.id)}
              onHire={() => onHire(agent)}
            />
          ) : loading ? (
            <div className="loading-state">Loading agent…</div>
          ) : (
            <Empty
              title="Agent not found"
              action={<Button href="/marketplace">Explore the marketplace</Button>}
            >
              This profile may be unavailable or inactive.
            </Empty>
          )
        ) : (
          <MarketplaceContent
            agents={allAgents}
            saved={saved}
            onSave={onSave}
            onHire={onHire}
            initialFilter={new URLSearchParams(location.search).get("category") || "All"}
          />
        )}
      </div>
      <SiteFooter />
    </div>
  );
}
