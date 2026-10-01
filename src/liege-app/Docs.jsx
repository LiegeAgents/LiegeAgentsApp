import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  Download,
  Search,
} from "lucide-react";
import { SiteFooter, SiteHeader } from "./Site";
import { docs } from "./data";
import { Button, Empty } from "./UI";

const asSection = (section) =>
  Array.isArray(section) ? { title: section[0], body: section[1] } : section;

function InlineText({ children }) {
  return String(children || "")
    .split(/(`[^`]+`)/g)
    .map((part, index) =>
      part.startsWith("`") && part.endsWith("`") ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : (
        <React.Fragment key={index}>{part}</React.Fragment>
      ),
    );
}

function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="doc-code-block">
      <div className="doc-code-head">
        <span>{code.label || code.language || "Example"}</span>
        <button type="button" onClick={copy} aria-label="Copy code example">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code.value}</code>
      </pre>
    </div>
  );
}

function DocSection({ section, index }) {
  const item = asSection(section);
  const paragraphs = Array.isArray(item.body) ? item.body : [item.body].filter(Boolean);
  return (
    <section id={`section-${index}`} className="doc-section">
      <h2>{item.title}</h2>
      {item.kicker && <span className="doc-kicker">{item.kicker}</span>}
      {paragraphs.map((paragraph, paragraphIndex) => (
        <p key={paragraphIndex}>
          <InlineText>{paragraph}</InlineText>
        </p>
      ))}
      {item.steps && (
        <ol className="doc-steps">
          {item.steps.map((step, stepIndex) => (
            <li key={stepIndex}>
              <span>{String(stepIndex + 1).padStart(2, "0")}</span>
              <div>
                <InlineText>{step}</InlineText>
              </div>
            </li>
          ))}
        </ol>
      )}
      {item.code && <CodeBlock code={item.code} />}
      {item.callout && (
        <aside className={`doc-callout ${item.callout.tone || ""}`}>
          <strong>{item.callout.title}</strong>
          <p>
            <InlineText>{item.callout.body}</InlineText>
          </p>
        </aside>
      )}
    </section>
  );
}

export default function Docs() {
  const slug = location.pathname.split("/")[2];
  const doc = docs[slug];
  const [query, setQuery] = useState("");
  const matches = Object.entries(docs).filter(([, item]) =>
    (item.title + " " + item.intro + " " + item.group).toLowerCase().includes(query.toLowerCase()),
  );
  const sections = doc?.sections?.map(asSection) || [];
  useEffect(() => {
    document.title = `${doc ? doc.title : "Documentation"} — Liege`;
  }, [slug]);
  return (
    <div className="liege-site reference-page">
      <SiteHeader announcement={false} />
      <main className="docs-layout">
        <aside className="docs-sidebar">
          <a className="docs-home" href="/docs">
            <BookOpen size={17} />
            Documentation
          </a>
          {[...new Set(Object.values(docs).map((item) => item.group))].map((group) => (
            <div className="docs-nav-group" key={group}>
              <h3>{group}</h3>
              {Object.entries(docs)
                .filter(([, item]) => item.group === group)
                .map(([id, item]) => (
                  <a
                    href={`/docs/${id}`}
                    className={slug === id ? "active" : ""}
                    aria-current={slug === id ? "page" : undefined}
                    key={id}
                  >
                    {item.eyebrow}
                  </a>
                ))}
            </div>
          ))}
        </aside>
        <div className="docs-content">
          {doc ? (
            <>
              <div className="doc-breadcrumb">
                <a href="/docs">Documentation</a>
                <ChevronRight size={12} />
                <span>{doc.eyebrow}</span>
              </div>
              <span className="eyebrow">{doc.group}</span>
              <h1>{doc.title}</h1>
              <p className="doc-intro">{doc.intro}</p>
              <div className="doc-source">
                Product design and implementation status · October 2026
              </div>
              <nav className="doc-contents" aria-label="On this page">
                {sections.map((section, index) => (
                  <a href={`#section-${index}`} key={section.title}>
                    {section.title}
                  </a>
                ))}
              </nav>
              {doc.quickstart && (
                <div className="doc-quickstart">
                  <span className="eyebrow">QUICK START</span>
                  <h2>{doc.quickstart.title}</h2>
                  <p>
                    <InlineText>{doc.quickstart.body}</InlineText>
                  </p>
                  <a href={`#section-${doc.quickstart.section || 0}`}>
                    Start setup <ArrowRight size={14} />
                  </a>
                </div>
              )}
              {doc.sections.map((section, index) => (
                <DocSection section={section} index={index} key={asSection(section).title} />
              ))}
              {slug === "brand" && (
                <div className="brand-downloads">
                  <img
                    src="/brand/banner-3x1.png"
                    alt="Liege banner with green lines and the loop logo on white"
                  />
                  <div>
                    <a className="l-button secondary" href="/brand/logo-transparent.png" download>
                      <Download size={15} />
                      Logo PNG
                    </a>
                    <a className="l-button secondary" href="/brand/banner-3x1.png" download>
                      <Download size={15} />
                      3:1 banner
                    </a>
                  </div>
                </div>
              )}
              <div className="doc-related">
                <h3>Continue exploring</h3>
                {doc.related?.map((id) => (
                  <a href={`/docs/${id}`} key={id}>
                    {docs[id].title}
                    <ArrowRight size={15} />
                  </a>
                ))}
              </div>
              <div className="doc-app-cta">
                <h3>Put the workflow in context.</h3>
                <p>Explore your wallet-authenticated workspace.</p>
                <Button href="/app">
                  Open workspace <ArrowUpRight size={14} />
                </Button>
              </div>
            </>
          ) : slug ? (
            <Empty
              title="This topic was not found"
              action={<Button href="/docs">Explore documentation</Button>}
            >
              Choose a topic from the navigation.
            </Empty>
          ) : (
            <>
              <span className="eyebrow">THE LIEGE KNOWLEDGE BASE</span>
              <h1>Understand the work.</h1>
              <p className="doc-intro">
                Everything you need to explore agents, jobs, evaluation, and client-controlled
                capital.
              </p>
              <label className="docs-search">
                <Search size={18} />
                <input
                  aria-label="Search documentation"
                  placeholder="Find a topic…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <span>⌕</span>
              </label>
              <div className="docs-card-grid">
                {matches.map(([id, item]) => (
                  <a href={`/docs/${id}`} key={id}>
                    <span className="eyebrow">{item.group}</span>
                    <h2>
                      {item.eyebrow}
                      <ArrowUpRight size={17} />
                    </h2>
                    <p>{item.intro}</p>
                  </a>
                ))}
              </div>
              {!matches.length && (
                <Empty title="No matching topics">
                  Try a broader search, such as “job” or “agent”.
                </Empty>
              )}
            </>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
