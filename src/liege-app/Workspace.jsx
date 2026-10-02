import React, { useState, useEffect, useMemo } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Plus,
  Search,
  LayoutGrid,
  BriefcaseBusiness,
  ShieldCheck,
  Wallet,
  Braces,
  BookOpen,
  ChevronRight,
  Bookmark,
  Download,
  Settings2,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Pause,
  Play,
  Power,
  Globe,
  Activity,
  ReceiptText,
} from "lucide-react";
import { Brand, AgentIcon } from "./ProductArt";
import { Button, Status, Empty, Modal, Field, Notice, SectionHeading } from "./UI";
import { money } from "./data";
import WorkspaceOverview from "./WorkspaceOverview";
import WorkspaceSearch from "./WorkspaceSearch";
import { MarketplaceContent, agentUrl } from "./Marketplace";
import { WalletButton, useWallet } from "./wallet/Wallet";
import SocialLinks from "./SocialLinks";
import { api, agentForDisplay, jobForDisplay } from "./api";
import "./live-jobs.css";

const KEY = "liege.workspace.v2";
const future = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const initial = () => ({ version: 2, saved: [] });
function read() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s?.version === 2 && Array.isArray(s.saved) ? s : initial();
  } catch {
    return initial();
  }
}
  const tabs = [
  ["overview", "Overview", LayoutGrid],
  ["agents", "Agent market", Globe],
  ["jobs", "Your jobs", BriefcaseBusiness],
  ["invoices", "USDG invoices", ReceiptText],
  ["services", "Services", Braces],
  ["evaluations", "Evaluations", Activity],
  ["launch", "Launch an agent", Plus],
  ["settings", "Workspace settings", Settings2],
];
export default function Workspace() {
  const [state, setState] = useState(read),
    [storageError, setStorageError] = useState(""),
    [view, setView] = useState(() =>
      new URLSearchParams(location.search).get("pay")
        ? "invoice-payment"
        : new URLSearchParams(location.search).get("view") || "overview",
    ),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState(
      () => new URLSearchParams(location.search).get("filter") || "All",
    ),
    [modal, setModal] = useState(null),
    [toast, setToast] = useState("");
  const wallet = useWallet();
  const [liveAgents, setLiveAgents] = useState([]),
    [liveJobs, setLiveJobs] = useState([]),
    [apiError, setApiError] = useState(""),
    [loadingLive, setLoadingLive] = useState(false);
  const allAgents = liveAgents;
  const allJobs = wallet.apiSession ? liveJobs : [];
  const refreshLive = async () => {
    setLoadingLive(true);
    setApiError("");
    try {
      const agents = await api.agents();
      setLiveAgents((agents.data || []).map(agentForDisplay));
      if (wallet.apiSession) {
        const jobs = await api.jobs("cookie");
        setLiveJobs((jobs.data || []).map(jobForDisplay));
      }
    } catch (e) {
      setApiError(e?.message || "Could not reach the Liege API.");
    } finally {
      setLoadingLive(false);
    }
  };
  useEffect(() => {
    refreshLive();
  }, [wallet.apiSession?.id]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("hire");
    if (id && allAgents.some((a) => a.id === id)) {
      setModal({ type: "create-job", agent: id });
      const url = new URL(location.href);
      url.searchParams.delete("hire");
      history.replaceState(null, "", url.pathname + url.search);
    }
  }, []);
  useEffect(() => {
    document.title = "Liege — Your workspace";
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      setStorageError("");
    } catch {
      setStorageError(
        "Browser storage is unavailable. Changes are in memory only; export your workspace before leaving.",
      );
    }
  }, [state]);
  useEffect(() => {
    const pop = () => {
      setView(
        new URLSearchParams(location.search).get("pay")
          ? "invoice-payment"
          : new URLSearchParams(location.search).get("view") || "overview",
      );
      setSearch("");
      setFilter(new URLSearchParams(location.search).get("filter") || "All");
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 5500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const navigate = (v, f = "All") => {
    setView(v);
    setSearch("");
    setFilter(f);
    history.pushState(
      null,
      "",
      `/app?view=${v}${f === "All" ? "" : "&filter=" + encodeURIComponent(f)}`,
    );
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    const key = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal((m) => (m?.type === "search" ? null : { type: "search" }));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const notify = (t) => setToast(t);
  const exportState = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "liege-workspace-preferences.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify("Workspace preferences exported.");
  };
  const draftFor = (a) => setModal({ type: "create-job", agent: a?.id });
  const active = allJobs.filter((j) => ["Funded", "Submitted"].includes(j.status)),
    escrow = active.reduce((n, j) => n + j.budget, 0);
  const visibleAgents = allAgents.filter(
    (a) =>
      (filter === "All" ||
        a.category === filter ||
        (filter === "Saved" && state.saved.includes(a.id))) &&
      (a.name + " " + a.description + " " + a.tags.join(" "))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const visibleJobs = allJobs.filter(
    (j) =>
      (filter === "All" || j.status === filter) &&
      (j.title + " " + j.id).toLowerCase().includes(search.toLowerCase()),
  );
  const paymentInvoiceId = new URLSearchParams(location.search).get("pay");
  const selectedJob = modal?.type === "job" ? allJobs.find((j) => j.id === modal.id) : null;
  const saveAgent = (id) =>
    setState((s) => ({
      ...s,
      saved: s.saved.includes(id) ? s.saved.filter((v) => v !== id) : [...s.saved, id],
    }));
  const saveLaunchedAgent = async (a) => {
    setLiveAgents((xs) => [a, ...xs]);
    notify("Agent published to the live marketplace.");
    navigate("agents");
  };
  const saveCreatedJob = (j) => {
    setLiveJobs((xs) => [j, ...xs]);
    notify("Encrypted job created in Liege.");
    setModal({ type: "job", id: j.id });
  };
  return (
    <div className="workspace">
      <aside className="app-sidebar">
        <Brand />
        <div className="workspace-picker">
          <span className="workspace-avatar">L</span>
          <span>
            Your workspace<small>{wallet.apiSession ? "Signed in" : "Connect wallet"}</small>
          </span>
          <ChevronRight size={14} />
        </div>
        <span className="sidebar-label">WORKSPACE</span>
        <nav aria-label="Workspace navigation">
          {tabs.slice(0, 3).map(([id, label, Icon]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              onClick={() => navigate(id)}
              aria-current={view === id ? "page" : undefined}
            >
              <Icon size={17} />
              {label}
              {id === "jobs" && <small>{allJobs.length}</small>}
            </button>
          ))}
        </nav>
        <span className="sidebar-label">BUILD</span>
        <nav aria-label="Build and settings">
          {tabs.slice(3).map(([id, label, Icon]) => (
            <button key={id} className={view === id ? "active" : ""} onClick={() => navigate(id)}>
              <Icon size={17} />
              {label}
            </button>
          ))}
          <a href="/docs">
            <BookOpen size={17} />
            Documentation
            <ArrowUpRight size={13} />
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-help">
            <span>Good work starts with a clear brief.</span>
            <a href="/docs/jobs">
              Explore the job lifecycle <ArrowRight size={13} />
            </a>
          </div>
          <a href="/">← Back to Liege</a>
        </div>
      </aside>
      <div className="app-content">
        <header className="app-topbar">
          <span className="app-breadcrumb">
            Workspace <ChevronRight size={12} />{" "}
            {tabs.find((t) => t[0] === view)?.[1] || "Overview"}
          </span>
          <div>
            <button
              className="workspace-search-trigger"
              onClick={() => setModal({ type: "search" })}
              aria-label="Search workspace"
            >
              <Search size={14} />
              <span>Search anything…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <span className="local-mode">
              <i />
              {wallet.apiSession ? "" : "Connect to begin"}
            </span>
            <WalletButton />
            <button
              className="icon-button export-workspace"
              aria-label="Export workspace preferences"
              title="Export workspace preferences"
              onClick={exportState}
            >
              <Download size={15} />
            </button>
          </div>
        </header>
        <nav className="app-mobile-nav" aria-label="Mobile workspace navigation">
          {tabs.map(([id, label]) => (
            <button key={id} className={view === id ? "active" : ""} onClick={() => navigate(id)}>
              {label}
            </button>
          ))}
        </nav>
        <main className="workspace-main">
          {!wallet.apiSession && (
            <div className="sample-notice">
              <span>
                <i /> SIGNED SESSION REQUIRED
              </span>
              Connect and sign in to create or view private jobs.
            </div>
          )}
          {storageError && <Notice error>{storageError}</Notice>}
          {apiError && <Notice error>{apiError}</Notice>}
          {paymentInvoiceId && (
            <InvoicePayment
              invoiceId={paymentInvoiceId}
              token={wallet.apiSession ? "cookie" : null}
              onNotice={notify}
            />
          )}
          {!paymentInvoiceId && (view === "overview" || !tabs.some((t) => t[0] === view)) && (
            <WorkspaceOverview
              state={{ ...state, jobs: allJobs }}
              agents={allAgents}
              account={wallet.apiSession}
              onCreate={() => draftFor()}
              onJob={(j) => setModal({ type: "job", id: j.id })}
              onAgent={(a) => {
                location.href = agentUrl(a);
              }}
              onHire={draftFor}
              navigate={navigate}
              onSaved={() => navigate("agents", "Saved")}
            />
          )}
          {!paymentInvoiceId && view === "agents" && (
            <MarketplaceContent
              agents={allAgents}
              saved={state.saved}
              onSave={saveAgent}
              onHire={draftFor}
              initialFilter={filter}
            />
          )}
          {!paymentInvoiceId && view === "jobs" && (
            <>
              <SectionHeading
                eyebrow="FROM BRIEF TO SETTLEMENT"
                title="Your jobs."
                action={
                  <Button onClick={() => draftFor()} disabled={!wallet.apiSession}>
                    <Plus size={15} />
                    Create a job
                  </Button>
                }
              >
                Jobs shown here are loaded from your Liege account.
              </SectionHeading>
              <div className="toolbar">
                <SearchField value={search} onChange={setSearch} label="Search jobs" />
                <select
                  aria-label="Filter jobs by status"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  {["All", "Open", "Funded", "Submitted", "Completed", "Rejected", "Expired"].map(
                    (s) => (
                      <option key={s}>{s}</option>
                    ),
                  )}
                </select>
              </div>
              {visibleJobs.length ? (
                <JobTable
                  jobs={visibleJobs}
                  agents={allAgents}
                  onSelect={(j) => setModal({ type: "job", id: j.id })}
                />
              ) : (
                <Empty title={wallet.apiSession ? "No jobs yet" : "Sign in to view jobs"}>
                  {wallet.apiSession
                    ? "Create a job when an agent is available in the marketplace."
                    : "Your private jobs are available after wallet sign-in."}
                </Empty>
              )}
              {wallet.apiSession && (
                <Notice>
                  Live jobs are private to their client, agent owner, and evaluator. Funding needs a
                  sufficient internal USDG balance.
                </Notice>
              )}
            </>
          )}
          {!paymentInvoiceId && view === "invoices" && (
            <InvoiceCenter
              token={wallet.apiSession ? "cookie" : null}
              agents={allAgents}
              accountId={wallet.apiSession?.id}
              ownerAddress={wallet.session.address}
              onNotice={notify}
            />
          )}
          {!paymentInvoiceId && view === "services" && (
            <ServiceCatalog
              token={wallet.apiSession ? "cookie" : null}
              agents={allAgents}
              ownerAddress={wallet.session.address}
              onNotice={notify}
            />
          )}
          {!paymentInvoiceId && view === "evaluations" && (
            <EvaluationCenter
              token={wallet.apiSession ? "cookie" : null}
              address={wallet.session.address}
              accountId={wallet.apiSession?.id}
              agents={allAgents}
              signMessage={wallet.signMessage}
              onNotice={notify}
            />
          )}
          {!paymentInvoiceId && view === "launch" && (
            <LaunchForm token={wallet.apiSession ? "cookie" : null} onSave={saveLaunchedAgent} />
          )}
          {!paymentInvoiceId && view === "settings" && (
            <>
              <SectionHeading eyebrow="WORKSPACE SETTINGS" title="Your account.">
                Manage your current wallet connection, evaluator profile, and saved shortlist.
              </SectionHeading>
              <div className="settings-panel">
                <h2>Shortlist</h2>
                <p>{state.saved.length} marketplace agents saved in this browser.</p>
                <Button onClick={exportState}>
                  <Download size={15} />
                  Export preferences
                </Button>
              </div>
              <div className="settings-panel">
                <h2>Connection status</h2>
                <p>
                  {wallet.session.address
                    ? `Connected as ${wallet.session.address} on ${wallet.ready ? "Robinhood Chain" : "another network"}.`
                    : "Use Connect wallet to open the wallet provider."}
                </p>
                {wallet.apiSession && (
                  <p className="mono muted">Account ID: {wallet.apiSession.id}</p>
                )}
                {wallet.session.address && (
                  <Button secondary onClick={wallet.disconnect}>
                    Disconnect wallet
                  </Button>
                )}
              </div>
              {wallet.apiSession && (
                <McpConnections
                  token="cookie"
                  agents={allAgents}
                  ownerAddress={wallet.session.address}
                  onNotice={notify}
                />
              )}
              {wallet.apiSession && (
                <AgentKillSwitch
                  token="cookie"
                  agents={allAgents}
                  ownerAddress={wallet.session.address}
                  onNotice={notify}
                />
              )}
              {wallet.apiSession && <ReceiptsPanel token="cookie" onNotice={notify} />}
              {wallet.apiSession && (
                <AgentRulebook
                  token="cookie"
                  agents={allAgents}
                  ownerAddress={wallet.session.address}
                  onNotice={notify}
                />
              )}
              {wallet.apiSession && <EvaluatorSetup token="cookie" />}
              {new URLSearchParams(location.search).get("operator") === "1" &&
                wallet.apiSession && (
                  <OperatorControls
                    token="cookie"
                    currentUser={wallet.apiSession}
                    onNotice={notify}
                  />
                )}
            </>
          )}
        </main>
        <footer className="app-footer">
          <span>
            liege <i /> Agents work. You’re the liege.
          </span>
          <div>
            <a href="/docs/privacy">Privacy</a>
            <a href="/docs/notice">Product notice</a>
            <a href="/docs/status">Product status</a>
          </div>
          <SocialLinks />
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={15} />
          {toast}
        </div>
      )}
      {modal?.type === "search" && (
        <WorkspaceSearch
          agents={allAgents}
          jobs={allJobs}
          onClose={() => setModal(null)}
          onJob={(j) => setModal({ type: "job", id: j.id })}
          onAgent={(a) => {
            location.href = agentUrl(a);
          }}
          navigate={navigate}
        />
      )}
      {modal?.type === "create-job" && (
        <CreateJob
          agents={allAgents}
          defaultAgent={modal.agent}
          token={wallet.apiSession ? "cookie" : null}
          onClose={() => setModal(null)}
          onSave={saveCreatedJob}
        />
      )}
      {modal?.type === "agent" && (
        <AgentDetail
          agent={modal.agent}
          onClose={() => setModal(null)}
          onHire={() => draftFor(modal.agent)}
        />
      )}
      {selectedJob && (
        <JobDetail
          job={selectedJob}
          agent={allAgents.find((a) => a.id === selectedJob.agent)}
          token="cookie"
          account={wallet.apiSession}
          onClose={() => setModal(null)}
          onUpdated={async (message) => {
            await refreshLive();
            notify(message);
          }}
        />
      )}
    </div>
  );
}

const serviceTypes = ["All", "tool", "data", "skill"];

function ServiceCatalog({ token, agents, ownerAddress, onNotice }) {
  const [services, setServices] = useState([]);
  const [type, setType] = useState("All");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const ownedAgents = agents.filter(
    (agent) => agent.owner_wallet?.toLowerCase() === ownerAddress?.toLowerCase(),
  );
  const [form, setForm] = useState({
    agentId: "",
    name: "",
    slug: "",
    description: "",
    serviceType: "skill",
    executionMode: "manual",
    priceUsd: "",
    slaMinutes: "60",
    requirementsSchema: "{}",
    deliverableSchema: "{}",
  });
  const load = async () => {
    setLoading(true);
    try {
      const result = await api.services({ type });
      setServices(result.data || []);
    } catch (error) {
      onNotice(error?.message || "Could not load the service catalog.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, [type]);
  useEffect(() => {
    if (!form.agentId && ownedAgents[0]) {
      setForm((current) => ({ ...current, agentId: ownedAgents[0].id }));
    }
  }, [ownedAgents.length, form.agentId]);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const create = async (event) => {
    event.preventDefault();
    let requirementsSchema;
    let deliverableSchema;
    try {
      requirementsSchema = JSON.parse(form.requirementsSchema || "{}");
      deliverableSchema = JSON.parse(form.deliverableSchema || "{}");
    } catch {
      onNotice("Requirements and deliverable schemas must be valid JSON.");
      return;
    }
    setSaving(true);
    try {
      await api.createService(token, {
        agentId: form.agentId,
        slug: form.slug.trim(),
        name: form.name.trim(),
        description: form.description.trim(),
        serviceType: form.serviceType,
        executionMode: form.executionMode,
        priceUsd: Number(form.priceUsd),
        slaMinutes: Number(form.slaMinutes),
        requirementsSchema,
        deliverableSchema,
      });
      setShowCreate(false);
      setForm((current) => ({ ...current, name: "", slug: "", description: "", priceUsd: "" }));
      onNotice("Service published to the catalog.");
      await load();
    } catch (error) {
      onNotice(error?.message || "Could not publish this service.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SectionHeading
        eyebrow="AGENT COMMERCE"
        title="Your service catalog."
        action={
          <Button onClick={() => setShowCreate((value) => !value)} disabled={!token || !ownedAgents.length}>
            <Plus size={15} /> {showCreate ? "Close form" : "Publish a service"}
          </Button>
        }
      >
        Publish tools, data, and skills with clear pricing, delivery windows, and execution boundaries.
      </SectionHeading>
      {showCreate && (
        <form className="settings-panel service-create-panel" onSubmit={create}>
          <div className="service-panel-heading">
            <div><span className="eyebrow">PUBLISH CAPABILITY</span><h2>New service</h2></div>
            <span className="mono muted">Owner approval required</span>
          </div>
          <Notice>Services are discoverable in the catalog. Publishing does not execute work or move funds.</Notice>
          <div className="form-grid">
            <Field label="Agent">
              <select required value={form.agentId} onChange={set("agentId")}>
                {ownedAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </Field>
            <Field label="Service type">
              <select value={form.serviceType} onChange={set("serviceType")}><option value="tool">Tool</option><option value="data">Data</option><option value="skill">Skill</option></select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label="Service name"><input required minLength={2} maxLength={120} value={form.name} onChange={set("name")} placeholder="Market research brief" /></Field>
            <Field label="Slug"><input required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={80} value={form.slug} onChange={set("slug")} placeholder="market-research" /></Field>
          </div>
          <Field label="Description" help="Explain inputs, deliverables, and what successful work means."><textarea required minLength={20} maxLength={4000} rows={3} value={form.description} onChange={set("description")} /></Field>
          <div className="form-grid">
            <Field label="Price (USD)"><input required type="number" min="0.01" step="0.01" value={form.priceUsd} onChange={set("priceUsd")} /></Field>
            <Field label="SLA (minutes)"><input required type="number" min="1" max="10080" step="1" value={form.slaMinutes} onChange={set("slaMinutes")} /></Field>
            <Field label="Execution mode"><select value={form.executionMode} onChange={set("executionMode")}><option value="manual">Manual approval</option><option value="sandboxed_runner">Sandboxed runner</option></select></Field>
          </div>
          <div className="form-grid">
            <Field label="Requirements schema (JSON)"><textarea rows={3} value={form.requirementsSchema} onChange={set("requirementsSchema")} /></Field>
            <Field label="Deliverable schema (JSON)"><textarea rows={3} value={form.deliverableSchema} onChange={set("deliverableSchema")} /></Field>
          </div>
          <Button type="submit" disabled={saving || !form.agentId}>{saving ? "Publishing…" : "Publish service"}<ArrowRight size={14} /></Button>
        </form>
      )}
      <div className="service-catalog-toolbar">
        <div><span className="eyebrow">LIVE CATALOG</span><strong>{loading ? "Loading…" : `${services.length} service${services.length === 1 ? "" : "s"}`}</strong></div>
        <div className="service-type-filter" role="group" aria-label="Filter services by type">
          {serviceTypes.map((value) => <button key={value} className={type === value ? "active" : ""} onClick={() => setType(value)}>{value}</button>)}
        </div>
      </div>
      {loading ? <Empty title="Loading services">Checking the live catalog.</Empty> : services.length === 0 ? <Empty title="No services found">Publish a capability for your agent or try another filter.</Empty> : (
        <div className="service-grid">
          {services.map((service) => <article className="service-card" key={service.id}>
            <div className="service-card-top"><span className="service-type">{service.service_type || service.serviceType}</span><Status value={service.execution_mode || service.executionMode || "manual"} /></div>
            <h2>{service.name}</h2><p>{service.description}</p>
            <div className="service-card-meta"><span><small>PRICE</small>${Number(service.price_usd ?? service.priceUsd).toFixed(2)}</span><span><small>SLA</small>{service.sla_minutes ?? service.slaMinutes} min</span></div>
            <div className="service-card-footer"><span className="mono">/{service.slug}</span><span>{service.agent_name || service.agentName || "Agent service"}</span></div>
          </article>)}
        </div>
      )}
      {!token && <Notice>Connect your wallet to publish services. The public catalog remains available without sign-in.</Notice>}
    </>
  );
}

function InvoiceCenter({ token, agents, accountId, ownerAddress, onNotice }) {
  const [invoices, setInvoices] = useState([]);
  const [agentId, setAgentId] = useState("");
  const [description, setDescription] = useState("Agent services");
  const [asset, setAsset] = useState("usdg");
  const [amount, setAmount] = useState("10");
  const [expiresAt, setExpiresAt] = useState(() =>
    new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16),
  );
  const [loading, setLoading] = useState(false);
  const ownedAgents = agents.filter(
    (agent) => agent.owner_wallet?.toLowerCase() === ownerAddress?.toLowerCase(),
  );
  const load = async () => {
    if (!token) return;
    try {
      const result = await api.invoices(token);
      setInvoices(result.data || []);
      setAgentId((current) => current || ownedAgents[0]?.id || "");
    } catch (error) {
      onNotice(error?.message || "Could not load invoices.");
    }
  };
  useEffect(() => {
    load();
  }, [token, ownedAgents.length]);
  const create = async (event) => {
    event.preventDefault();
    if (!agentId) return;
    setLoading(true);
    try {
      const result = await api.createInvoice(token, {
        agentId,
        description,
        asset,
        amount,
        amountUsdg: amount,
        expiresAt: new Date(expiresAt).toISOString(),
      });
      setInvoices((items) => [result.data, ...items]);
      onNotice(`${(asset || "usdg").toUpperCase()} invoice issued. Share its payment link with the payer.`);
    } catch (error) {
      onNotice(error?.message || "Could not issue invoice.");
    } finally {
      setLoading(false);
    }
  };
  const act = async (action, invoice) => {
    try {
      const result = await action(token, invoice.id);
      setInvoices((items) => items.map((item) => (item.id === invoice.id ? result.data : item)));
      onNotice(`Invoice ${result.data.status}.`);
    } catch (error) {
      onNotice(error?.message || "Invoice action could not be completed.");
    }
  };
  const copy = async (invoice) => {
    const url = `${location.origin}/app?pay=${encodeURIComponent(invoice.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      onNotice("Payment link copied.");
    } catch {
      onNotice("Copy failed. Copy the payment URL from your browser.");
    }
  };
  return (
    <>
      <SectionHeading
        eyebrow="LIEGE PAY · MULTI-ASSET"
        title="Invoice agent work."
        action={
          <a className="button secondary" href="/docs/payments">
            Payment docs <ArrowUpRight size={14} />
          </a>
        }
      >
        Issue invoices in USDG or LIEGE, receive an auditable ledger receipt, and refund a paid invoice
        once.
      </SectionHeading>
      <section className="settings-panel invoice-create-panel">
        <h2>Create invoice</h2>
        <form onSubmit={create} className="mcp-create-form">
          <Field label="Agent profile">
            <select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              disabled={!ownedAgents.length}
            >
              {!ownedAgents.length && <option>No owned agent profiles found</option>}
              {ownedAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Description">
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              minLength={3}
              maxLength={500}
            />
          </Field>
          <div className="form-grid">
            <Field label="Settlement asset">
              <select value={asset} onChange={(event) => setAsset(event.target.value)}>
                <option value="usdg">USDG (Robinhood Chain)</option>
                <option value="liege">LIEGE (Robinhood Chain)</option>
              </select>
            </Field>
            <Field label={`Amount (${(asset || "usdg").toUpperCase()})`}>
              <input
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                inputMode="decimal"
              />
            </Field>
          </div>
          <Field label="Expiry">
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
          <div className="form-actions">
            <Button type="submit" disabled={loading || !agentId}>
              {loading ? "Issuing…" : `Issue ${(asset || "usdg").toUpperCase()} invoice`}
            </Button>
          </div>
        </form>
      </section>
      <section className="settings-panel invoice-list-panel">
        <div className="mcp-list-head">
          <h2>Invoices</h2>
          <span>{invoices.length} total</span>
        </div>
        {!token ? (
          <Empty title="Sign in to issue invoices">A signed wallet session is required.</Empty>
        ) : !invoices.length ? (
          <Empty title="No invoices yet">Create one for an owned agent profile.</Empty>
        ) : (
          invoices.map((invoice) => (
            <div className="mcp-connection-row invoice-row" key={invoice.id}>
              <div className="mcp-connection-name">
                <span className="mcp-status" />
                <div>
                  <strong>{invoice.description}</strong>
                  <small>
                    {invoice.publicId} · {Number(invoice.amount ?? invoice.amountUsdg).toLocaleString()} {(invoice.asset || "usdg").toUpperCase()} ·{" "}
                    {invoice.status}
                  </small>
                </div>
              </div>
              <div className="invoice-actions">
                <Button secondary small onClick={() => copy(invoice)}>
                  Copy link
                </Button>
                {invoice.status === "issued" && invoice.issuerId === accountId && (
                  <Button secondary small onClick={() => act(api.cancelInvoice, invoice)}>
                    Cancel
                  </Button>
                )}
                {invoice.status === "paid" && invoice.issuerId === accountId && (
                  <Button small onClick={() => act(api.refundInvoice, invoice)}>
                    Refund
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </section>
    </>
  );
}

function InvoicePayment({ invoiceId, token, onNotice }) {
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .invoicePayment(invoiceId)
      .then((result) => {
        if (active) setInvoice(result.data);
      })
      .catch((error) => active && onNotice(error?.message || "This payment link is unavailable."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [invoiceId]);
  const pay = async () => {
    setPaying(true);
    try {
      const result = await api.payInvoice(token, invoiceId);
      setInvoice((current) => ({ ...current, ...result.data }));
      onNotice("Invoice paid. Your USDG receipt is recorded.");
    } catch (error) {
      onNotice(error?.message || "Invoice payment failed.");
    } finally {
      setPaying(false);
    }
  };
  if (loading) return <Empty title="Loading invoice">Checking USDG payment terms…</Empty>;
  if (!invoice)
    return (
      <Empty title="Invoice unavailable">
        Check that the payment link is complete and has not been cancelled.
      </Empty>
    );
  return (
    <section className="settings-panel invoice-payment-panel">
      <span className="eyebrow">LIEGE PAY · {(invoice.asset || "usdg").toUpperCase()} INVOICE</span>
      <h1>{invoice.description}</h1>
      <p className="mono muted">{invoice.publicId}</p>
      <div className="invoice-payment-amount">
        {Number(invoice.amount ?? invoice.amountUsdg).toLocaleString()} <small>{(invoice.asset || "usdg").toUpperCase()}</small>
      </div>
      <p>
        Issued for agent work. This payment is settled via the internal Liege ledger.
      </p>
      <p>
        Expires {new Date(invoice.expiresAt).toLocaleString()} · Status:{" "}
        <strong>{invoice.status}</strong>
      </p>
      {invoice.status === "issued" &&
        (token ? (
          <Button onClick={pay} disabled={paying}>
            {paying ? "Paying…" : "Pay invoice"}
          </Button>
        ) : (
          <Notice>
            Connect and sign in with the wallet that holds the {(invoice.asset || "usdg").toUpperCase()} balance to pay this invoice.
          </Notice>
        ))}
      {invoice.status !== "issued" && (
        <Notice>
          {invoice.status === "paid"
            ? "This invoice has already been paid."
            : "This invoice is no longer payable."}
        </Notice>
      )}
    </section>
  );
}

function McpConnections({ token, agents, ownerAddress, onNotice }) {
  const [connections, setConnections] = useState([]);
  const [name, setName] = useState("My agent runtime");
  const [agentId, setAgentId] = useState("");
  const [newToken, setNewToken] = useState("");
  const [loading, setLoading] = useState(false);
  const ownedAgents = agents.filter(
    (agent) => agent.owner_wallet?.toLowerCase() === ownerAddress?.toLowerCase(),
  );
  const load = async () => {
    try {
      const result = await api.mcpConnections(token);
      setConnections(result.data || []);
      setAgentId((current) => current || ownedAgents[0]?.id || "");
    } catch (error) {
      onNotice(error?.message || "Could not load MCP connections.");
    }
  };
  useEffect(() => {
    load();
  }, [token, ownedAgents.length]);
  const create = async (event) => {
    event.preventDefault();
    if (!agentId || name.trim().length < 2) return;
    setLoading(true);
    try {
      const result = await api.createMcpConnection(token, { agentId, name: name.trim() });
      setNewToken(result.data.token);
      setConnections((items) => [
        {
          ...result.data,
          name: name.trim(),
          agent_id: agentId,
          created_at: new Date().toISOString(),
        },
        ...items,
      ]);
      onNotice("MCP connection created. Copy the token now; it is shown only once.");
    } catch (error) {
      onNotice(error?.message || "Could not create MCP connection.");
    } finally {
      setLoading(false);
    }
  };
  const revoke = async (id) => {
    try {
      await api.revokeMcpConnection(token, id);
      setConnections((items) =>
        items.map((item) =>
          item.id === id ? { ...item, revoked_at: new Date().toISOString() } : item,
        ),
      );
      onNotice("MCP connection revoked.");
    } catch (error) {
      onNotice(error?.message || "Could not revoke MCP connection.");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(newToken);
      onNotice("MCP token copied.");
    } catch {
      onNotice("Copy failed. Select the token and copy it manually.");
    }
  };
  return (
    <section className="settings-panel mcp-settings-panel">
      <div className="mcp-settings-heading">
        <div>
          <span className="eyebrow">EXTERNAL AGENT ACCESS</span>
          <h2>Connect an MCP client</h2>
          <p>
            Give one external runtime access to one of your agent profiles. Connections can inspect
            scoped context and create proposals; they cannot bypass your approval.
          </p>
        </div>
        <a href="/docs/mcp" className="mcp-guide-link">
          Setup guide <ExternalLink size={14} />
        </a>
      </div>
      {newToken && (
        <div className="mcp-token-card" role="status">
          <div>
            <span className="eyebrow">COPY THIS TOKEN NOW</span>
            <strong>It will not be shown again.</strong>
            <p>Paste it into this agent’s MCP configuration. It expires after 30 days.</p>
          </div>
          <div className="mcp-token-value">
            <code>{newToken}</code>
            <Button secondary onClick={copy}>
              <Copy size={14} /> Copy
            </Button>
          </div>
        </div>
      )}
      <form onSubmit={create} className="mcp-create-form">
        <Field label="Agent profile">
          <select
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            disabled={!ownedAgents.length}
          >
            {!ownedAgents.length && <option>No owned profiles found</option>}
            {ownedAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Connection name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Research agent in Cursor"
            minLength={2}
            maxLength={80}
          />
        </Field>
        <div className="form-actions">
          <Button type="submit" disabled={loading || !ownedAgents.length}>
            {loading ? "Creating…" : "Create MCP connection"}
          </Button>
        </div>
      </form>
      {!ownedAgents.length && (
        <div className="mcp-empty-note">
          Launch an agent profile first, then return here to create its MCP connection.
        </div>
      )}
      {connections.length > 0 && (
        <div className="mcp-connection-list">
          <div className="mcp-list-head">
            <h3>Connections</h3>
            <span>{connections.filter((connection) => !connection.revoked_at).length} active</span>
          </div>
          {connections.map((connection) => (
            <div className="mcp-connection-row" key={connection.id}>
              <div className="mcp-connection-name">
                <span className={connection.revoked_at ? "mcp-status revoked" : "mcp-status"} />
                <div>
                  <strong>{connection.name || "MCP connection"}</strong>
                  <small>
                    {ownedAgents.find((agent) => agent.id === connection.agent_id)?.name ||
                      "Agent profile"}{" "}
                    ·{" "}
                    {connection.revoked_at
                      ? "Revoked"
                      : `Expires ${new Date(connection.expires_at).toLocaleDateString()}`}
                  </small>
                </div>
              </div>
              {connection.revoked_at ? (
                <span className="mcp-revoked-label">Revoked</span>
              ) : (
                <Button secondary small onClick={() => revoke(connection.id)}>
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const accountStatusLabel = { active: "Active", paused: "Paused", killed: "Killed" };

function AgentKillSwitch({ token, agents, ownerAddress, onNotice }) {
  const [accounts, setAccounts] = useState({});
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState("");
  const [reason, setReason] = useState("");
  const ownedAgents = agents.filter(
    (agent) => agent.owner_wallet?.toLowerCase() === ownerAddress?.toLowerCase(),
  );
  useEffect(() => {
    api
      .agentAccounts(token)
      .then((result) =>
        setAccounts(
          Object.fromEntries((result.data || []).map((account) => [account.agentId, account])),
        ),
      )
      .catch((error) => onNotice(error?.message || "Could not load agent accounts."));
  }, [token, ownedAgents.length]);
  const control = async (agent, command) => {
    setBusy(agent.id);
    try {
      const result = await api.controlAgentAccount(token, agent.id, {
        command,
        ...(command === "kill" && reason.trim() ? { reason: reason.trim() } : {}),
      });
      setAccounts((current) => ({
        ...current,
        [agent.id]: {
          ...current[agent.id],
          status: result.data.status,
          killReason: result.data.killReason,
          pausedAt:
            result.data.status === "active"
              ? null
              : current[agent.id]?.pausedAt || new Date().toISOString(),
        },
      }));
      setConfirming("");
      setReason("");
      onNotice(
        command === "kill"
          ? `${agent.name} was killed. ${result.data.revokedConnections} connection(s) revoked, ${result.data.rejectedProposals} pending proposal(s) rejected.`
          : command === "pause"
            ? `${agent.name} is paused. It cannot create proposals or start runs.`
            : `${agent.name} is active again.`,
      );
    } catch (error) {
      onNotice(error?.message || "Could not update this agent.");
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="settings-panel mcp-settings-panel agent-kill-panel">
      <div className="mcp-settings-heading">
        <div>
          <span className="eyebrow">AGENT ACCOUNTS</span>
          <h2>Kill switch</h2>
          <p>
            Pause an agent to stop it instantly. It cannot create proposals or start runs, and
            nothing it queued can be approved until you resume it. Kill ends its access for good:
            every MCP connection is revoked and every pending proposal is rejected.
          </p>
        </div>
      </div>
      {!ownedAgents.length ? (
        <div className="mcp-empty-note">
          Launch an agent profile first. Its controls will appear here.
        </div>
      ) : (
        <div className="mcp-connection-list">
          <div className="mcp-list-head">
            <h3>Your agents</h3>
            <span>
              {
                ownedAgents.filter((agent) => (accounts[agent.id]?.status || "active") === "active")
                  .length
              }{" "}
              running
            </span>
          </div>
          {ownedAgents.map((agent) => {
            const account = accounts[agent.id];
            const status = account?.status || "active";
            return (
              <div className="agent-kill-row" key={agent.id}>
                <div className="mcp-connection-row">
                  <div className="mcp-connection-name">
                    <span className={`mcp-status agent-status-${status}`} />
                    <div>
                      <strong>{agent.name}</strong>
                      <small>
                        {status === "active"
                          ? account?.policy
                            ? `Policy v${account.policy.version} · accepting work`
                            : "Accepting work"
                          : status === "paused"
                            ? `Paused ${new Date(account.pausedAt).toLocaleString()}`
                            : `Killed${account?.killReason ? ` · ${account.killReason}` : ""}`}
                      </small>
                    </div>
                  </div>
                  <div className="agent-kill-actions">
                    <Status value={accountStatusLabel[status]} />
                    {status === "active" && (
                      <Button
                        secondary
                        small
                        disabled={busy === agent.id}
                        onClick={() => control(agent, "pause")}
                      >
                        <Pause size={13} /> Pause
                      </Button>
                    )}
                    {status === "paused" && (
                      <Button
                        secondary
                        small
                        disabled={busy === agent.id}
                        onClick={() => control(agent, "resume")}
                      >
                        <Play size={13} /> Resume
                      </Button>
                    )}
                    {status !== "killed" && (
                      <button
                        className="agent-kill-button"
                        disabled={busy === agent.id}
                        onClick={() => setConfirming(confirming === agent.id ? "" : agent.id)}
                      >
                        <Power size={13} /> Kill
                      </button>
                    )}
                  </div>
                </div>
                {confirming === agent.id && (
                  <div className="agent-kill-confirm" role="alert">
                    <p>
                      Killing <strong>{agent.name}</strong> is permanent. It cannot be resumed.
                    </p>
                    <input
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Reason (optional)"
                      maxLength={500}
                    />
                    <div>
                      <Button secondary small onClick={() => setConfirming("")}>
                        Cancel
                      </Button>
                      <button
                        className="agent-kill-button solid"
                        disabled={busy === agent.id}
                        onClick={() => control(agent, "kill")}
                      >
                        <Power size={13} /> {busy === agent.id ? "Killing…" : "Kill agent"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const receiptTypeLabel = {
  admin_credit: "Deposit",
  invoice_payment: "Invoice payment",
  invoice_refund: "Invoice refund",
  job_fund: "Job funded",
  job_settlement: "Job settlement",
  evaluator_fee: "Evaluator fee",
  job_refund: "Job refund",
  job_expiry_refund: "Expired job refund",
  stake_lock: "Stake locked",
  stake_unlock: "Stake released",
};
const receiptLabel = (type) =>
  receiptTypeLabel[type] || type.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
const receiptAmount = (value, asset) => {
  const amount = Number(value);
  return `${amount > 0 ? "+" : ""}${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${asset.toUpperCase()}`;
};
const receiptChanges = (line) =>
  [
    Number(line.availableChange) && receiptAmount(line.availableChange, line.asset),
    Number(line.stakeChange) && `${receiptAmount(line.stakeChange, line.asset)} stake`,
  ].filter(Boolean);

function ReceiptsPanel({ token, onNotice }) {
  const [lines, setLines] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    api
      .receipts(token)
      .then((result) => setLines(result.data || []))
      .catch((error) => {
        setLines([]);
        onNotice(error?.message || "Could not load receipts.");
      });
  }, [token]);
  const show = async (receiptId) => {
    try {
      setOpen((await api.receipt(token, receiptId)).data);
    } catch (error) {
      onNotice(error?.message || "Could not load this receipt.");
    }
  };
  return (
    <section className="settings-panel mcp-settings-panel receipts-panel">
      <div className="mcp-settings-heading">
        <div>
          <span className="eyebrow">LEDGER</span>
          <h2>Receipts &amp; exports</h2>
          <p>
            Every payment, refund, and settlement on your account, itemized and linked to its job or
            invoice. Each receipt and export carries a SHA-256 digest so you can prove it was not
            changed.
          </p>
        </div>
        <div className="receipts-exports">
          <Button secondary small href={api.receiptExportUrl("csv")} download>
            <Download size={13} /> CSV
          </Button>
          <Button secondary small href={api.receiptExportUrl("json")} download>
            <Download size={13} /> JSON
          </Button>
        </div>
      </div>
      {lines && !lines.length ? (
        <div className="mcp-empty-note">
          No ledger activity yet. Receipts appear here after your first deposit, job, or invoice.
        </div>
      ) : (
        <div className="mcp-connection-list">
          <div className="mcp-list-head">
            <h3>Recent receipts</h3>
            <span>{lines ? `${lines.length} shown` : "Loading…"}</span>
          </div>
          {(lines || []).map((line) => (
            <button
              className="receipt-row"
              key={`${line.receiptId}-${line.asset}`}
              onClick={() => show(line.receiptId)}
            >
              <span className="receipt-icon">
                <ReceiptText size={14} />
              </span>
              <span className="receipt-main">
                <strong>{receiptLabel(line.type)}</strong>
                <small>
                  {line.subject
                    ? `${line.subject.publicId} · ${line.subject.title}`
                    : "Account activity"}{" "}
                  · {new Date(line.createdAt).toLocaleDateString()}
                </small>
              </span>
              <span className="receipt-amounts">
                {receiptChanges(line).map((change) => (
                  <b key={change} className={change.startsWith("+") ? "credit" : "debit"}>
                    {change}
                  </b>
                ))}
              </span>
              <ArrowUpRight size={14} />
            </button>
          ))}
        </div>
      )}
      {open && (
        <Modal title="Receipt" onClose={() => setOpen(null)}>
          <div className="receipt-card">
            <div className="receipt-card-head">
              <span>{receiptLabel(open.type)}</span>
              <div>
                {open.lines.flatMap(receiptChanges).map((change) => (
                  <strong key={change}>{change}</strong>
                ))}
              </div>
            </div>
            <dl>
              {open.subject && (
                <>
                  <dt>{open.subject.type === "job" ? "Job" : "Invoice"}</dt>
                  <dd>
                    {open.subject.publicId} · {open.subject.title}
                  </dd>
                  <dt>Agent</dt>
                  <dd>{open.subject.agentName}</dd>
                </>
              )}
              <dt>Date</dt>
              <dd>{new Date(open.createdAt).toLocaleString()}</dd>
              <dt>Receipt ID</dt>
              <dd className="mono">{open.receiptId}</dd>
              <dt>Reference</dt>
              <dd className="mono">{open.reference}</dd>
              <dt>SHA-256</dt>
              <dd className="mono receipt-digest">{open.digest}</dd>
            </dl>
            <Button
              secondary
              small
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([JSON.stringify(open, null, 2)], { type: "application/json" }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = `liege-receipt-${open.receiptId}.json`;
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download size={13} /> Download receipt
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

const ruleDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ruleHours = Array.from({ length: 24 }, (_, hour) => hour);
const ruleHourLabel = (hour) => `${String(hour).padStart(2, "0")}:00`;
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const ruleAmount = (value) => (value === "" || value == null ? null : Number(value));

function rulebookForm(policy) {
  return {
    maxActionAmount: policy?.maxActionAmount ?? "",
    dailyBudget: policy?.dailyBudget ?? "",
    monthlyBudget: policy?.monthlyBudget ?? "",
    requireHumanAbove: policy?.requireHumanAbove ?? "",
    approvalMode: policy?.approvalMode || "always",
    allowedAssets: (policy?.allowedAssets || []).join(", "),
    hoursEnabled: Boolean(policy?.activeHours),
    start: policy?.activeHours?.start ?? 9,
    end: policy?.activeHours?.end ?? 17,
    activeDays: policy?.activeDays || [],
    timezone:
      policy?.activeHours || policy?.activeDays?.length
        ? policy.timezone || "UTC"
        : browserTimeZone(),
  };
}

function AgentRulebook({ token, agents, ownerAddress, onNotice }) {
  const ownedAgents = agents.filter(
    (agent) => agent.owner_wallet?.toLowerCase() === ownerAddress?.toLowerCase(),
  );
  const [agentId, setAgentId] = useState("");
  const [policy, setPolicy] = useState(null);
  const [form, setForm] = useState(rulebookForm(null));
  const [saving, setSaving] = useState(false);
  const selected = agentId || ownedAgents[0]?.id || "";
  useEffect(() => {
    if (!selected) return;
    let active = true;
    api
      .agentAccount(token, selected)
      .then((result) => {
        if (!active) return;
        setPolicy(result.data.policy);
        setForm(rulebookForm(result.data.policy));
      })
      .catch((error) => onNotice(error?.message || "Could not load this agent's rules."));
    return () => {
      active = false;
    };
  }, [token, selected]);
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const toggleDay = (day) =>
    setForm((current) => ({
      ...current,
      activeDays: current.activeDays.includes(day)
        ? current.activeDays.filter((value) => value !== day)
        : [...current.activeDays, day].sort(),
    }));
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api.updateAgentPolicy(token, selected, {
        // Rules this form does not edit are sent back unchanged.
        allowedVenues: policy?.allowedVenues || [],
        approvedCounterparties: policy?.approvedCounterparties || [],
        allowedActions: policy?.allowedActions || [],
        simulationRequired: policy?.simulationRequired ?? true,
        maxActionAmount: ruleAmount(form.maxActionAmount),
        dailyBudget: ruleAmount(form.dailyBudget),
        monthlyBudget: ruleAmount(form.monthlyBudget),
        requireHumanAbove: ruleAmount(form.requireHumanAbove),
        approvalMode: form.approvalMode,
        allowedAssets: form.allowedAssets
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        activeHours: form.hoursEnabled
          ? { start: Number(form.start), end: Number(form.end) }
          : null,
        activeDays: form.hoursEnabled ? form.activeDays : [],
        timezone: form.timezone,
      });
      setPolicy(result.data.policy);
      setForm(rulebookForm(result.data.policy));
      onNotice(`Rulebook saved as policy v${result.data.policy.version}.`);
    } catch (error) {
      onNotice(error?.message || "Could not save these rules.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="settings-panel mcp-settings-panel agent-rulebook-panel">
      <div className="mcp-settings-heading">
        <div>
          <span className="eyebrow">AGENT ACCOUNTS</span>
          <h2>Rulebook</h2>
          <p>
            Set the limits each agent works within. Anything over your approval threshold waits for
            you, and anything outside its active hours is refused. Every save creates a new policy
            version, so the agent can never act on rules you have replaced.
          </p>
        </div>
        {policy && <span className="rulebook-version">Policy v{policy.version}</span>}
      </div>
      {!ownedAgents.length ? (
        <div className="mcp-empty-note">
          Launch an agent profile first. Its rulebook will appear here.
        </div>
      ) : (
        <form className="rulebook-form" onSubmit={save}>
          <Field label="Agent">
            <select value={selected} onChange={(event) => setAgentId(event.target.value)}>
              {ownedAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="rulebook-section">
            <h3>Spending</h3>
            <div className="rulebook-grid">
              <Field label="Max per action" help="USDG. Larger actions are refused.">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.maxActionAmount}
                  onChange={set("maxActionAmount")}
                  placeholder="No limit"
                />
              </Field>
              <Field label="Daily budget" help="USDG per day.">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.dailyBudget}
                  onChange={set("dailyBudget")}
                  placeholder="No limit"
                />
              </Field>
              <Field label="Monthly budget" help="USDG per month.">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.monthlyBudget}
                  onChange={set("monthlyBudget")}
                  placeholder="No limit"
                />
              </Field>
            </div>
          </div>
          <div className="rulebook-section">
            <h3>Approval</h3>
            <div className="rulebook-grid">
              <Field label="Ask me first">
                <select value={form.approvalMode} onChange={set("approvalMode")}>
                  <option value="always">For every action</option>
                  <option value="within_policy">Only above my threshold</option>
                </select>
              </Field>
              <Field label="Require my approval above" help="USDG. Held for you, not refused.">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={form.requireHumanAbove}
                  onChange={set("requireHumanAbove")}
                  placeholder="No threshold"
                />
              </Field>
              <Field label="Allowed assets" help="Comma separated. Empty allows any asset.">
                <input
                  value={form.allowedAssets}
                  onChange={set("allowedAssets")}
                  placeholder="usdg, liege"
                />
              </Field>
            </div>
          </div>
          <div className="rulebook-section">
            <div className="rulebook-section-head">
              <h3>Active hours</h3>
              <label className="rulebook-toggle">
                <input
                  type="checkbox"
                  checked={form.hoursEnabled}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, hoursEnabled: event.target.checked }))
                  }
                />
                Only let this agent act during set hours
              </label>
            </div>
            {form.hoursEnabled && (
              <>
                <div className="rulebook-grid">
                  <Field label="From">
                    <select value={form.start} onChange={set("start")}>
                      {ruleHours.map((hour) => (
                        <option key={hour} value={hour}>
                          {ruleHourLabel(hour)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Until" help="Earlier than From runs overnight.">
                    <select value={form.end} onChange={set("end")}>
                      {ruleHours.map((hour) => (
                        <option key={hour} value={hour}>
                          {ruleHourLabel(hour)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Time zone">
                    <input value={form.timezone} onChange={set("timezone")} />
                  </Field>
                </div>
                <div className="rulebook-days" role="group" aria-label="Active days">
                  {ruleDays.map((label, day) => (
                    <button
                      type="button"
                      key={label}
                      className={form.activeDays.includes(day) ? "active" : ""}
                      aria-pressed={form.activeDays.includes(day)}
                      onClick={() => toggleDay(day)}
                    >
                      {label}
                    </button>
                  ))}
                  <small>
                    {form.activeDays.length ? "Only on the selected days." : "Every day."}
                  </small>
                </div>
              </>
            )}
          </div>
          <div className="form-actions">
            <Button
              type="submit"
              disabled={
                saving ||
                !selected ||
                (form.hoursEnabled && Number(form.start) === Number(form.end))
              }
            >
              {saving ? "Saving…" : "Save rulebook"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function SearchField({ value, onChange, label }) {
  return (
    <label className="search-field">
      <Search size={16} />
      <input
        aria-label={label}
        placeholder={label + "…"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function AgentCard({ agent: a, saved, onSave, onView, onHire }) {
  return (
    <article className="agent-card">
      <div className="agent-card-top">
        <AgentIcon agent={a} />
        <button
          className={"icon-button bookmark" + (saved ? " saved" : "")}
          aria-label={`${saved ? "Unsave" : "Save"} ${a.name}`}
          aria-pressed={saved}
          onClick={onSave}
        >
          <Bookmark size={17} fill={saved ? "currentColor" : "none"} />
        </button>
      </div>
      <button className="agent-name" onClick={onView}>
        {a.name}
        <span>{a.draft ? "Draft" : a.symbol}</span>
        <ArrowUpRight size={15} />
      </button>
      <p>{a.description}</p>
      <div className="agent-tags">
        {a.tags.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <div className="agent-card-meta">
        <span>{a.draft ? "New local profile" : `${a.jobs} completed jobs`}</span>
        <span>{a.draft ? "Unpublished" : `${a.score}% reputation score`}</span>
      </div>
      <div className="agent-card-bottom">
        <span>
          From{" "}
          <b>
            {money(a.price)} <small>USDG</small>
          </b>
        </span>
        <Button small secondary onClick={onHire}>
          Hire agent <ArrowRight size={13} />
        </Button>
      </div>
    </article>
  );
}
function JobTable({ jobs, agents, onSelect }) {
  return (
    <div className="table-scroll">
      <table className="job-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Agent</th>
            <th>Status</th>
            <th>Budget</th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>
                <button onClick={() => onSelect(j)}>
                  <strong>{j.title}</strong>
                  <small>{j.id}</small>
                </button>
              </td>
              <td>
                <span className="table-agent">
                  <AgentIcon agent={agents.find((a) => a.id === j.agent)} size={14} />
                  {agents.find((a) => a.id === j.agent)?.name || j.agent}
                </span>
              </td>
              <td>
                <Status value={j.status} />
              </td>
              <td className="mono">
                {money(j.budget)} <small>{String(j.asset || "usdg").toUpperCase()}</small>
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={"Open " + j.title}
                  onClick={() => onSelect(j)}
                >
                  <ArrowUpRight size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function AgentDetail({ agent: a, onClose, onHire }) {
  return (
    <Modal title={a.name} onClose={onClose}>
      <div className="dialog-body">
        <div className="agent-detail-intro">
          <AgentIcon agent={a} size={32} />
          <div>
            <span className="eyebrow">{a.draft ? "LOCAL PROFILE DRAFT" : "PUBLISHED AGENT"}</span>
            <p>{a.description}</p>
          </div>
        </div>
        <div className="agent-tags">
          {a.tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <div className="key-values">
          <div>
            <span>Category</span>
            <b>{a.category}</b>
          </div>
          <div>
            <span>Starting job fee</span>
            <b>{money(a.price)} USDG</b>
          </div>
          <div>
            <span>Identity</span>
            <b>{a.draft ? "Unpublished draft" : "Illustrative profile"}</b>
          </div>
        </div>
        <h3>Define a good job</h3>
        <p>
          Specify the output, acceptance criteria, deadline, and evaluator before funding. Your
          first step is a private job brief.
        </p>
        <Button onClick={onHire}>
          Create a job for {a.name} <ArrowRight size={14} />
        </Button>
      </div>
    </Modal>
  );
}
function CreateJob({ agents, defaultAgent, token, onClose, onSave }) {
  const [v, setV] = useState({
      title: "",
      brief: "",
      criteria: "",
      agent: defaultAgent || agents[0]?.id,
      evaluator: "",
      settlementAsset: "usdg",
      budget: agents.find((a) => a.id === defaultAgent)?.price || 0,
      deadline: future(7),
    }),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [simulating, setSimulating] = useState(false),
    [simulation, setSimulation] = useState(null),
    [evaluators, setEvaluators] = useState([]);
  useEffect(() => {
    let active = true;
    api
      .evaluators()
      .then((result) => {
        if (active) setEvaluators(result.data || []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const change = (k, val) => {
      setV({ ...v, [k]: val });
      setError("");
      setSimulation(null);
    },
    agent = agents.find((a) => a.id === v.agent);
  const submit = async (e) => {
    e.preventDefault();
    if (!token) {
      setError("Sign in with your wallet before creating a job.");
      return;
    }
    if (!agent) {
      setError("Choose an active marketplace agent.");
      return;
    }
    const acceptanceCriteria = v.criteria
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!acceptanceCriteria.length) {
      setError("Add at least one acceptance criterion.");
      return;
    }
    setSaving(true);
    try {
      const deadline = new Date(`${v.deadline}T23:59:59.999Z`),
        expires = new Date(deadline.getTime() + 7 * 864e5);
      const input = {
        agentId: v.agent,
        evaluatorId: v.evaluator || undefined,
        title: v.title.trim(),
        brief: v.brief.trim(),
        acceptanceCriteria,
        settlementAsset: v.settlementAsset,
        ...(v.settlementAsset === "liege" ? { budgetLiege: v.budget } : { budgetUsdg: v.budget }),
        deadlineAt: deadline.toISOString(),
        expiresAt: expires.toISOString(),
      };
      const result = await api.createJob(token, input);
      onSave(jobForDisplay(result.data));
    } catch (e) {
      setError(e?.message || "Could not create this job.");
    } finally {
      setSaving(false);
    }
  };
  const preview = async () => {
    if (!token || !agent) return;
    const acceptanceCriteria = v.criteria
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!acceptanceCriteria.length) {
      setError("Add at least one acceptance criterion before running the preflight.");
      return;
    }
    setSimulating(true);
    setError("");
    try {
      const deadline = new Date(`${v.deadline}T23:59:59.999Z`);
      const result = await api.simulateJob(token, {
        agentId: v.agent,
        evaluatorId: v.evaluator || undefined,
        title: v.title.trim(),
        brief: v.brief.trim(),
        acceptanceCriteria,
        settlementAsset: v.settlementAsset,
        ...(v.settlementAsset === "liege" ? { budgetLiege: v.budget } : { budgetUsdg: v.budget }),
        deadlineAt: deadline.toISOString(),
        expiresAt: new Date(deadline.getTime() + 7 * 864e5).toISOString(),
      });
      setSimulation(result.data);
    } catch (e) {
      setError(e?.message || "The preflight simulation could not be completed.");
    } finally {
      setSimulating(false);
    }
  };
  return (
    <Modal title="Create a job" onClose={onClose} wide>
      <form onSubmit={submit} className="dialog-body">
        <Notice>
          Your brief is encrypted before storage. Choose an independent evaluator now so the job can
          settle after delivery.
        </Notice>
        <Field label="Job title">
          <input
            autoFocus
            required
            minLength={5}
            maxLength={100}
            value={v.title}
            onChange={(e) => change("title", e.target.value)}
            placeholder="What needs to get done?"
          />
        </Field>
        <Field
          label="Private brief"
          help="Describe the inputs, output format, constraints, and delivery context."
        >
          <textarea
            required
            minLength={30}
            maxLength={4000}
            rows={4}
            value={v.brief}
            onChange={(e) => change("brief", e.target.value)}
            placeholder="Describe the output, sources, format, and relevant context."
          />
        </Field>
        <Field
          label="Acceptance criteria"
          help="One check per line. The evaluator uses these criteria when settling the job."
        >
          <textarea
            required
            rows={3}
            value={v.criteria}
            onChange={(e) => change("criteria", e.target.value)}
            placeholder={
              "Source-linked report\nCovers the agreed scope\nDelivered in the requested format"
            }
          />
        </Field>
        <div className="form-grid">
          <Field label="Agent">
            <select value={v.agent || ""} onChange={(e) => change("agent", e.target.value)}>
              <option value="" disabled>
                Select an active agent
              </option>
              {agents.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name} · {a.category}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Independent evaluator">
            <select value={v.evaluator} onChange={(e) => change("evaluator", e.target.value)}>
              <option value="">No evaluator assigned</option>
              {evaluators.map((e) => {
                const stake = Number(e.stake_usdg || 0);
                return (
                  <option key={e.user_id} value={e.user_id}>
                    {e.wallet_address.slice(0, 8)}…{e.wallet_address.slice(-6)} · {money(stake)}{" "}
                    USDG staked
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="Settlement asset">
            <select
              value={v.settlementAsset}
              onChange={(e) => change("settlementAsset", e.target.value)}
            >
              <option value="usdg">USDG</option>
              <option value="liege">LIEGE</option>
            </select>
          </Field>
          <Field label={`Job budget (${v.settlementAsset.toUpperCase()})`}>
            <input
              type="number"
              min="0.01"
              step="0.01"
              required
              value={v.budget}
              onChange={(e) => change("budget", e.target.value)}
            />
          </Field>
          <Field label="Deadline">
            <input
              type="date"
              min={future(1)}
              required
              value={v.deadline}
              onChange={(e) => change("deadline", e.target.value)}
            />
          </Field>
        </div>
        {!evaluators.length && (
          <Notice>
            No eligible independent evaluators are listed yet. You can create a job without one, but
            it cannot be settled until an evaluator is assigned.
          </Notice>
        )}
        {simulation && (
          <Notice error={!simulation.ready}>
            <strong>{simulation.ready ? "Preflight passed" : "Preflight blocked"}</strong>
            <span>
              {simulation.settlement.totalEscrow} {simulation.settlement.asset.toUpperCase()} escrow
              · {simulation.checks.filter((check) => check.status === "fail").length} blocking
              checks
            </span>
          </Notice>
        )}
        {error && <Notice error>{error}</Notice>}
        <div className="form-actions">
          <Button type="button" secondary onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !token}>
            {saving ? "Creating…" : "Create encrypted job"} <ArrowRight size={14} />
          </Button>
          <Button type="button" secondary onClick={preview} disabled={simulating || !token}>
            {simulating ? "Checking…" : "Run preflight"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function JobDetail({ job, agent, token, account, onClose, onUpdated }) {
  const [detail, setDetail] = useState(null),
    [payloadAccess, setPayloadAccess] = useState([]),
    [observability, setObservability] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [deliverable, setDeliverable] = useState(""),
    [evidence, setEvidence] = useState(""),
    [rationale, setRationale] = useState("");
  const wallet = useWallet();
  const load = async () => {
    setError("");
    try {
      const result = await api.job(token, job.id);
      const base = result.data;
      const payloads = await Promise.allSettled([
        api.jobPayload(token, job.id, "brief"),
        base.submission ? api.jobPayload(token, job.id, "deliverable") : Promise.resolve(null),
        api.jobPayloadAccess(token, job.id),
        api.jobObservability(token, job.id),
      ]);
      const brief = payloads[0].status === "fulfilled" ? payloads[0].value?.data : null;
      const delivery = payloads[1].status === "fulfilled" ? payloads[1].value?.data : null;
      setPayloadAccess(payloads[2].status === "fulfilled" ? payloads[2].value?.data || [] : []);
      setObservability(payloads[3].status === "fulfilled" ? payloads[3].value?.data || [] : []);
      setDetail({
        ...base,
        brief: brief?.content || "Private brief unavailable or expired.",
        submission: base.submission
          ? {
              ...base.submission,
              deliverable: delivery?.content || "Delivery unavailable or expired.",
            }
          : null,
      });
    } catch (e) {
      setError(e?.message || "Could not load this private job.");
    }
  };
  useEffect(() => {
    load();
  }, [job.id]);
  const act = async (kind, fn, message) => {
    setBusy(kind);
    setError("");
    try {
      await fn();
      await load();
      await onUpdated(message);
    } catch (e) {
      setError(e?.message || "The job action could not be completed.");
    } finally {
      setBusy("");
    }
  };
  const current = detail || job,
    status = String(current.status || job.status).replace(/^./, (x) => x.toUpperCase()),
    isClient = detail?.client_id === account?.id,
    isProvider = detail?.provider_id === account?.id,
    isEvaluator =
      detail?.evaluator_id === account?.id ||
      Boolean(detail && !detail.evaluator_id && detail.client_id === account?.id),
    canSettle = isEvaluator;
  let criteria = [];
  try {
    criteria = Array.isArray(current.acceptance_criteria)
      ? current.acceptance_criteria
      : typeof current.acceptance_criteria === "string"
        ? JSON.parse(current.acceptance_criteria || "[]")
        : [];
  } catch {}
  return (
    <Modal title={job.title} onClose={onClose} wide>
      <div className="dialog-body">
        <div className="job-detail-top">
          <span className="mono muted">{job.id}</span>
          <Status value={status} />
        </div>
        {!detail && !error && <Notice>Loading private job details…</Notice>}
        <div className="key-values grid-2">
          <div>
            <span>Agent</span>
            <b>{detail?.agent_name || agent?.name || job.agent}</b>
          </div>
          <div>
            <span>Budget</span>
            <b>
              {money(Number(current.budget_amount ?? current.budget_usdg ?? current.budget))}{" "}
              {(current.settlement_asset || current.asset || "usdg").toUpperCase()}
            </b>
          </div>
          <div>
            <span>Deadline</span>
            <b>{String(current.deadline_at || job.deadline || "—").slice(0, 10)}</b>
          </div>
          <div>
            <span>Your role</span>
            <b>
              {isClient
                ? "Client"
                : isProvider
                  ? "Agent operator"
                  : isEvaluator
                    ? "Evaluator"
                    : "Participant"}
            </b>
          </div>
        </div>
        <h3>Private brief</h3>
        <p className="job-brief">{current.brief || "Loading…"}</p>
        <h3>Acceptance criteria</h3>
        <ul className="job-criteria">
          {criteria.map((item, index) => (
            <li key={index}>
              <Check size={13} />
              {item}
            </li>
          ))}
        </ul>
        {current.submission && (
          <>
            <h3>Delivery</h3>
            <p className="job-brief">{current.submission.deliverable}</p>
            {current.submission.evidence?.length > 0 && (
              <div className="evidence-links">
                {current.submission.evidence.map((url) => (
                  <a key={url} href={url} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} />
                    {url}
                  </a>
                ))}
              </div>
            )}
          </>
        )}
        {current.evaluation && (
          <>
            <h3>Evaluation · {current.evaluation.outcome}</h3>
            <p className="job-brief">{current.evaluation.rationale}</p>
          </>
        )}
        <details className="payload-access-history">
          <summary>Private payload access history</summary>
          {payloadAccess.length ? (
            <ul>
              {payloadAccess.map((event) => {
                const metadata = event.metadata || {};
                return (
                  <li key={event.id}>
                    <span>{event.action === "job.payload_accessed" ? "Allowed" : "Denied"}</span>
                    <span>{metadata.payload || "payload"}</span>
                    <span>{metadata.role || "—"}</span>
                    <time dateTime={event.created_at}>
                      {new Date(event.created_at).toLocaleString()}
                    </time>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p>No payload retrievals recorded yet.</p>
          )}
        </details>
        <details className="payload-access-history">
          <summary>Execution observability</summary>
          {observability.length ? (
            <ul>
              {observability.map((run) => (
                <li key={run.id}>
                  <span>{run.command}</span>
                  <span>{run.status}</span>
                  <span>{run.events?.length || 0} trace events</span>
                  <time dateTime={run.created_at}>{new Date(run.created_at).toLocaleString()}</time>
                </li>
              ))}
            </ul>
          ) : (
            <p>No execution traces recorded yet.</p>
          )}
        </details>
        {error && <Notice error>{error}</Notice>}
        {detail && (
          <div className="live-job-action">
            <h3>Live job action</h3>
            {status === "Open" && isClient && (
              <>
                <p>
                  {detail.escrow_mode === "onchain"
                    ? `Your wallet will send the ${String(detail.settlement_asset || "usdg").toUpperCase()} budget and a quoted $1 ETH reserve to this job’s escrow wallet. The escrow wallet pays settlement gas and returns its remaining ETH to you.`
                    : `Fund ${money(Number(detail.budget_amount ?? detail.budget_usdg) + Number(detail.evaluator_fee_amount ?? detail.evaluator_fee_usdg ?? 0))} ${String(detail.settlement_asset || "usdg").toUpperCase()} from your internal Liege balance into escrow.`}
                </p>
                <Button
                  onClick={() =>
                    act(
                      "fund",
                      () =>
                        detail.escrow_mode === "onchain"
                          ? wallet.fundEscrow(job.id)
                          : api.fundJob(token, job.id),
                      "Job funded and moved into escrow.",
                    )
                  }
                  disabled={busy === "fund"}
                >
                  {busy === "fund" ? "Funding…" : "Fund job"} <Wallet size={14} />
                </Button>
              </>
            )}
            {status === "Funded" && isProvider && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const urls = evidence
                    .split(/\n|,/)
                    .map((x) => x.trim())
                    .filter(Boolean);
                  act(
                    "submit",
                    () => api.submitJob(token, job.id, { deliverable, evidence: urls }),
                    "Delivery submitted for evaluation.",
                  );
                }}
              >
                <p>Submit the final work. Liege encrypts the delivery at rest.</p>
                <Field label="Delivery">
                  <textarea
                    required
                    minLength={1}
                    rows={5}
                    value={deliverable}
                    onChange={(e) => setDeliverable(e.target.value)}
                    placeholder="Provide the completed work or a clear delivery summary."
                  />
                </Field>
                <Field label="Evidence links" help="Optional. One HTTPS URL per line.">
                  <textarea
                    rows={2}
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    placeholder="https://…"
                  />
                </Field>
                <Button type="submit" disabled={busy === "submit"}>
                  {busy === "submit" ? "Submitting…" : "Submit delivery"} <ArrowRight size={14} />
                </Button>
              </form>
            )}
            {status === "Submitted" && isEvaluator && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  act(
                    "evaluate",
                    () => api.evaluateJob(token, job.id, { outcome: "accepted", rationale }),
                    "Job accepted and escrow settled.",
                  );
                }}
              >
                <p>
                  Review the private delivery against the agreed criteria. Accepting releases escrow
                  to the agent owner.
                </p>
                <Field label="Evaluation rationale">
                  <textarea
                    required
                    minLength={1}
                    rows={4}
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                    placeholder="Explain how the delivery meets the criteria."
                  />
                </Field>
                <div className="job-actions">
                  <Button type="submit" disabled={busy === "accept"}>
                    {busy === "accept" ? "Settling…" : "Accept and settle"} <Check size={14} />
                  </Button>
                  <Button
                    type="button"
                    secondary
                    disabled={busy === "reject" || !rationale.trim()}
                    onClick={() =>
                      act(
                        "reject",
                        () => api.evaluateJob(token, job.id, { outcome: "rejected", rationale }),
                        "Job rejected and escrow refunded to the client.",
                      )
                    }
                  >
                    {busy === "reject" ? "Rejecting…" : "Reject and refund"}
                  </Button>
                </div>
              </form>
            )}
            {status === "Open" && !isClient && <p>Waiting for the client to fund this job.</p>}
            {status === "Funded" && !isProvider && (
              <p>Escrow is funded. Waiting for the agent operator to submit delivery.</p>
            )}
            {status === "Submitted" && !isEvaluator && (
              <p>
                {detail.evaluator_id
                  ? "Waiting for the assigned evaluator to settle this job."
                  : "No evaluator is assigned, so this submitted job cannot settle yet."}
              </p>
            )}
            {["Completed", "Rejected", "Expired", "Cancelled"].includes(status) && (
              <p>
                This job is closed.{" "}
                {detail.escrow_mode === "onchain"
                  ? "Settlement transaction hashes are retained in Liege’s escrow record."
                  : "Its final status is recorded in the Liege ledger."}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
function EvaluationCenter({ token, address, accountId, agents, signMessage, onNotice }) {
  const [tasks, setTasks] = useState([]),
    [evaluators, setEvaluators] = useState([]),
    [title, setTitle] = useState("Research quality review"),
    [instructions, setInstructions] = useState(
      "Review the work against each criterion and provide evidence.",
    ),
    [agentId, setAgentId] = useState(""),
    [evaluatorId, setEvaluatorId] = useState(""),
    [criteria, setCriteria] = useState([
      { id: "accuracy", prompt: "Are the claims accurate?", weight: "60", maxScore: "10" },
      { id: "evidence", prompt: "Is the evidence sufficient?", weight: "40", maxScore: "10" },
    ]),
    [dueAt, setDueAt] = useState(() => new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 16)),
    [scores, setScores] = useState({}),
    [rationales, setRationales] = useState({}),
    [evidence, setEvidence] = useState({}),
    [outcomes, setOutcomes] = useState({}),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const ownedAgents = agents.filter(
    (agent) => address && agent.owner_wallet?.toLowerCase() === address.toLowerCase(),
  );
  const load = async () => {
    if (!token) return;
    try {
      const [taskResult, evaluatorResult] = await Promise.all([
        api.evaluationTasks(token),
        api.evaluators(),
      ]);
      setTasks(taskResult.data || []);
      setEvaluators(evaluatorResult.data || []);
      if (!agentId && ownedAgents[0]) setAgentId(ownedAgents[0].id);
      if (!evaluatorId && evaluatorResult.data?.[0])
        setEvaluatorId(evaluatorResult.data[0].user_id);
    } catch (e) {
      setError(e?.message || "Could not load evaluation tasks.");
    }
  };
  useEffect(() => {
    load();
  }, [token, address, agents.length]);
  const updateCriterion = (index, key, value) =>
    setCriteria((items) =>
      items.map((item, i) => (i === index ? { ...item, [key]: value } : item)),
    );
  const create = async (event) => {
    event.preventDefault();
    setBusy("create");
    setError("");
    try {
      await api.createEvaluationTask(token, {
        agentId,
        evaluatorId,
        title,
        instructions,
        dueAt: new Date(dueAt).toISOString(),
        criteria: criteria.map((item) => ({
          ...item,
          weight: Number(item.weight),
          maxScore: Number(item.maxScore),
        })),
      });
      onNotice("Evaluation task assigned.");
      await load();
    } catch (e) {
      setError(e?.message || "Could not create evaluation task.");
    } finally {
      setBusy("");
    }
  };
  const submit = async (task) => {
    setBusy(task.id);
    setError("");
    const taskScores = scores[task.id] || {};
    if ((task.criteria || []).some((item) => taskScores[item.id] === undefined)) {
      setBusy("");
      setError("Score every criterion before submitting the decision.");
      return;
    }
    const payload = {
      outcome: outcomes[task.id] || "accepted",
      scores: taskScores,
      rationale: rationales[task.id] || "",
      evidence: (evidence[task.id] || "")
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    };
    try {
      const preview = await api.evaluationDecisionMessage(token, task.id, payload);
      if (!signMessage) throw new Error("Connect a wallet to sign the evaluation decision.");
      const signature = await signMessage(preview.data.message);
      await api.submitEvaluationDecision(token, task.id, { ...payload, signature });
      onNotice("Signed evaluation decision submitted.");
      await load();
    } catch (e) {
      setError(e?.message || "Could not submit signed decision.");
    } finally {
      setBusy("");
    }
  };
  if (!token)
    return (
      <Empty title="Sign in to use evaluations">
        Connect your wallet and sign in to create or review structured evaluation tasks.
      </Empty>
    );
  return (
    <>
      <SectionHeading eyebrow="STRUCTURED REVIEW" title="Evaluation service.">
        Create review tasks or sign decisions assigned to your wallet. These records do not settle
        marketplace escrow.
      </SectionHeading>
      <div className="settings-panel">
        <h2>Create an evaluation task</h2>
        {!ownedAgents.length && (
          <Notice error>Publish an agent first; task creation is limited to agents you own.</Notice>
        )}
        <form onSubmit={create}>
          <Field label="Agent">
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} required>
              <option value="">Select an owned agent</option>
              {ownedAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Evaluator">
            <select value={evaluatorId} onChange={(e) => setEvaluatorId(e.target.value)} required>
              <option value="">Select an eligible evaluator</option>
              {evaluators.map((item) => (
                <option key={item.user_id} value={item.user_id}>
                  {item.wallet_address.slice(0, 8)}…{item.wallet_address.slice(-6)} ·{" "}
                  {Number(item.stake_usdg || 0).toLocaleString()} USDG
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label="Instructions">
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              required
            />
          </Field>
          <Field label="Due">
            <input
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              required
            />
          </Field>
          <div className="evaluation-criteria">
            {criteria.map((item, index) => (
              <div className="evaluation-criterion" key={index}>
                <input
                  aria-label="Criterion id"
                  value={item.id}
                  onChange={(e) => updateCriterion(index, "id", e.target.value)}
                />
                <input
                  aria-label="Criterion prompt"
                  value={item.prompt}
                  onChange={(e) => updateCriterion(index, "prompt", e.target.value)}
                />
                <input
                  aria-label="Criterion weight"
                  type="number"
                  value={item.weight}
                  onChange={(e) => updateCriterion(index, "weight", e.target.value)}
                />
                <input
                  aria-label="Criterion max score"
                  type="number"
                  value={item.maxScore}
                  onChange={(e) => updateCriterion(index, "maxScore", e.target.value)}
                />
              </div>
            ))}
          </div>
          <Button type="submit" disabled={busy === "create" || !ownedAgents.length}>
            {busy === "create" ? "Creating…" : "Assign evaluation task"}
          </Button>
        </form>
      </div>
      <div className="evaluation-task-list">
        <h2>Your evaluation tasks</h2>
        {!tasks.length && (
          <Empty title="No evaluation tasks">Assigned and created tasks will appear here.</Empty>
        )}
        {tasks.map((task) => {
          const assigned = task.evaluator_id === accountId && task.status === "assigned";
          return (
            <div className="settings-panel" key={task.id}>
              <div className="task-heading">
                <div>
                  <span className="eyebrow">{task.status}</span>
                  <h2>{task.title}</h2>
                </div>
                <span className="mono muted">{task.id.slice(0, 8)}…</span>
              </div>
              <p>{task.instructions}</p>
              {assigned && (
                <div>
                  <label className="field-label">
                    Outcome
                    <select
                      value={outcomes[task.id] || "accepted"}
                      onChange={(e) => setOutcomes((v) => ({ ...v, [task.id]: e.target.value }))}
                    >
                      <option value="accepted">Accepted</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  </label>
                  {(task.criteria || []).map((item) => (
                    <label className="field-label" key={item.id}>
                      {item.prompt}
                      <input
                        type="number"
                        min="0"
                        max={item.maxScore}
                        value={scores[task.id]?.[item.id] ?? ""}
                        onChange={(e) =>
                          setScores((v) => ({
                            ...v,
                            [task.id]: { ...(v[task.id] || {}), [item.id]: Number(e.target.value) },
                          }))
                        }
                      />
                    </label>
                  ))}
                  <label className="field-label">
                    Rationale
                    <textarea
                      value={rationales[task.id] || ""}
                      onChange={(e) => setRationales((v) => ({ ...v, [task.id]: e.target.value }))}
                      placeholder="Explain the decision…"
                    />
                  </label>
                  <label className="field-label">
                    Evidence links
                    <textarea
                      value={evidence[task.id] || ""}
                      onChange={(e) => setEvidence((v) => ({ ...v, [task.id]: e.target.value }))}
                      placeholder="One HTTPS link per line"
                    />
                  </label>
                  <Button onClick={() => submit(task)} disabled={busy === task.id}>
                    {busy === task.id ? "Waiting for wallet…" : "Sign and submit decision"}
                  </Button>
                </div>
              )}
              {task.status === "submitted" && <Status value="Submitted" />}
            </div>
          );
        })}
      </div>
      {error && <Notice error>{error}</Notice>}
    </>
  );
}
function EvaluatorSetup({ token }) {
  const [profile, setProfile] = useState(null),
    [specialties, setSpecialties] = useState(""),
    [active, setActive] = useState(false),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    let mounted = true;
    api
      .evaluatorProfile(token)
      .then((result) => {
        if (!mounted) return;
        const p = result.data;
        setProfile(p);
        setSpecialties((p?.specialties || []).join(", "));
        setActive(Boolean(p?.active));
      })
      .catch((e) => mounted && setError(e?.message || "Could not load evaluator profile."));
    return () => {
      mounted = false;
    };
  }, [token]);
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api.updateEvaluatorProfile(token, {
        specialties: specialties
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        active,
      });
      setProfile(result.data);
    } catch (e) {
      setError(e?.message || "Could not save evaluator profile.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="settings-panel" onSubmit={save}>
      <h2>Evaluator profile</h2>
      <p>
        Activate this only if you are available to independently review delivery. Listing requires
        operator-assigned stake of at least 5,000 USDG.
      </p>
      <Field label="Specialties" help="Comma-separated, for example: Research, Data analysis">
        <input
          value={specialties}
          onChange={(e) => setSpecialties(e.target.value)}
          placeholder="Research, Automation"
        />
      </Field>
      <label className="check-field">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Available to evaluate jobs
      </label>
      {profile && (
        <p className="mono muted">Profile status: {profile.active ? "active" : "inactive"}</p>
      )}
      {error && <Notice error>{error}</Notice>}
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save evaluator profile"} <ShieldCheck size={14} />
      </Button>
    </form>
  );
}
function OperatorControls({ token, currentUser, onNotice }) {
  const [creditUser, setCreditUser] = useState(currentUser.id),
    [credit, setCredit] = useState("1000"),
    [creditReference, setCreditReference] = useState("test-credit-" + Date.now()),
    [stakeUser, setStakeUser] = useState(currentUser.id),
    [stake, setStake] = useState("5000"),
    [stakeReference, setStakeReference] = useState("test-stake-" + Date.now()),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const run = async (kind, fn, message) => {
    setBusy(kind);
    setError("");
    try {
      await fn();
      onNotice(message);
    } catch (e) {
      setError(e?.message || "Operator action was denied.");
    } finally {
      setBusy("");
    }
  };
  return (
    <section className="settings-panel operator-panel">
      <span className="eyebrow">OPERATOR-ONLY TEST CONTROLS</span>
      <h2>Test ledger setup</h2>
      <p>
        These controls are not part of normal navigation. Every request is checked again by the
        backend admin-wallet allowlist and recorded in the audit ledger. USDG here is internal test
        credit, never an on-chain transfer.
      </p>
      <div className="form-grid">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(
              "credit",
              () =>
                api.creditTestBalance(token, {
                  userId: creditUser,
                  amountUsdg: +credit,
                  reference: creditReference,
                }),
              "Test USDG credited to the selected account.",
            );
          }}
        >
          <Field label="Account ID to credit">
            <input required value={creditUser} onChange={(e) => setCreditUser(e.target.value)} />
          </Field>
          <Field label="Credit amount (USDG)">
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={credit}
              onChange={(e) => setCredit(e.target.value)}
            />
          </Field>
          <Field label="Audit reference">
            <input
              required
              minLength={8}
              value={creditReference}
              onChange={(e) => setCreditReference(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy === "credit"}>
            {busy === "credit" ? "Crediting…" : "Credit test USDG"}
          </Button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(
              "stake",
              () =>
                api.setEvaluatorStake(token, {
                  userId: stakeUser,
                  stakeUsdg: +stake,
                  reference: stakeReference,
                }),
              "Evaluator test stake updated.",
            );
          }}
        >
          <Field label="Evaluator account ID">
            <input required value={stakeUser} onChange={(e) => setStakeUser(e.target.value)} />
          </Field>
          <Field label="Set evaluator stake (USDG)">
            <input
              type="number"
              min="0"
              step="0.01"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
            />
          </Field>
          <Field label="Audit reference">
            <input
              required
              minLength={8}
              value={stakeReference}
              onChange={(e) => setStakeReference(e.target.value)}
            />
          </Field>
          <Button type="submit" secondary disabled={busy === "stake"}>
            {busy === "stake" ? "Updating…" : "Set test stake"}
          </Button>
        </form>
      </div>
      <div className="form-actions">
        <Button
          type="button"
          secondary
          disabled={busy === "backfill"}
          onClick={() =>
            run(
              "backfill",
              () => api.backfillEscrows(token, { limit: 100 }),
              "Open legacy jobs received encrypted on-chain escrow wallets.",
            )
          }
        >
          {busy === "backfill" ? "Backfilling…" : "Backfill open jobs to on-chain escrow"}
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
    </section>
  );
}
function PolicyForm({ policy, onSave, onPause }) {
  const [p, setP] = useState(policy),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => setP(policy), [policy]);
  const change = (k, v) => {
    setP({ ...p, [k]: v });
    setSaved(false);
    setError("");
  };
  const submit = (e) => {
    e.preventDefault();
    const err = validatePolicy(p);
    if (err) {
      setError(err);
      return;
    }
    onSave({ ...p, total: +p.total, perTrade: +p.perTrade, drawdown: +p.drawdown });
    setSaved(true);
  };
  return (
    <>
      <SectionHeading
        eyebrow="CLIENT-CONTROLLED CAPITAL"
        title="Your strategy. Your limits."
        action={
          <Button secondary onClick={onPause}>
            {policy.paused ? <Play size={15} /> : <Pause size={15} />}{" "}
            {policy.paused ? "Resume sample execution" : "Pause sample execution"}
          </Button>
        }
      >
        Configure a local permission policy for a strategy agent.
      </SectionHeading>
      <div className="wallet-layout">
        <div>
          <div className="wallet-summary">
            <div>
              <span className="eyebrow">STRATEGY PERMISSIONS</span>
              <Status value={policy.paused ? "Paused" : "Active"} />
            </div>
            <strong>
              {money(policy.total)} <span>USDG</span>
            </strong>
            <p>Total permitted notional · local policy</p>
            <div className="wallet-trace" aria-hidden="true">
              <svg viewBox="0 0 600 100">
                <path
                  d="M0 76 Q50 66 90 68 T170 51 T240 56 T320 38 T390 44 T460 26 T530 22 T600 10"
                  fill="none"
                  stroke="#18e299"
                  strokeWidth="1.5"
                />
              </svg>
              <span>PERMISSION ILLUSTRATION · NO PERFORMANCE DATA</span>
            </div>
            <div className="wallet-summary-bottom">
              <span>Execution is {policy.paused ? "paused" : "enabled in this sample"}</span>
              <ShieldCheck size={17} />
            </div>
          </div>
          <Notice>
            The sample wallet has no address or balance. This chart is decorative and does not
            represent investment performance.
          </Notice>
          <div className="settings-panel">
            <h3>Capital stays with the client.</h3>
            <p>
              In the intended product, permissions are enforced by the strategy wallet. Job fees are
              held separately in USDG escrow.
            </p>
            <a href="/docs/wallets">
              Read the wallet model <ArrowRight size={14} />
            </a>
          </div>
        </div>
        <form className="policy-form" onSubmit={submit}>
          <h2>Permission policy</h2>
          <div className="form-grid">
            <Field label="Total cap (USDG)">
              <input
                type="number"
                required
                min="1"
                value={p.total}
                onChange={(e) => change("total", e.target.value)}
              />
            </Field>
            <Field label="Per-trade cap (USDG)">
              <input
                type="number"
                required
                min="1"
                value={p.perTrade}
                onChange={(e) => change("perTrade", e.target.value)}
              />
            </Field>
            <Field label="Maximum drawdown (%)">
              <input
                type="number"
                required
                min="0.1"
                max="100"
                step="0.1"
                value={p.drawdown}
                onChange={(e) => change("drawdown", e.target.value)}
              />
            </Field>
            <Field label="Permission expiry">
              <input
                type="date"
                required
                min={future(1)}
                value={p.expires}
                onChange={(e) => change("expires", e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Allowed tokens"
            help="Illustrative labels; production requires verified token addresses."
          >
            <input required value={p.tokens} onChange={(e) => change("tokens", e.target.value)} />
          </Field>
          <Field label="Allowed venues" help="Production requires an enforced contract allowlist.">
            <input required value={p.venues} onChange={(e) => change("venues", e.target.value)} />
          </Field>
          {error && <Notice error>{error}</Notice>}
          {saved && (
            <p className="success-text" role="status">
              <Check size={15} />
              Local permissions saved.
            </p>
          )}
          <Button type="submit">
            Save local permissions <ArrowRight size={14} />
          </Button>
        </form>
      </div>
    </>
  );
}
function LaunchForm({ token, onSave }) {
  const [v, setV] = useState({
      name: "",
      symbol: "",
      category: "Research",
      description: "",
      price: 100,
    }),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const change = (k, value) => {
    setV({ ...v, [k]: value });
    setError("");
  };
  const submit = async (e) => {
    e.preventDefault();
    if (!token) {
      setError("Sign in with your wallet before publishing an agent.");
      return;
    }
    if (!/^[A-Z0-9]{2,8}$/.test(v.symbol)) {
      setError("Use 2–8 uppercase letters or numbers for the symbol.");
      return;
    }
    if (+v.price <= 0) {
      setError("Enter a positive starting job fee.");
      return;
    }
    setSaving(true);
    try {
      const slug = `${v.name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
      const result = await api.createAgent(token, {
        slug,
        name: v.name.trim(),
        description: v.description.trim(),
        category: v.category,
        capabilities: [v.category],
        metadata: { startingJobFeeUsdg: +v.price, symbol: v.symbol },
      });
      await onSave(agentForDisplay(result.data));
    } catch (e) {
      setError(e?.message || "Could not publish this agent.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SectionHeading eyebrow="BUILD SOMETHING USEFUL" title="Bring your agent to work.">
        Publish a service profile with a signed wallet session.
      </SectionHeading>
      <div className="launch-layout">
        <form className="policy-form" onSubmit={submit}>
          <h2>Publish agent</h2>
          <Notice>
            {token
              ? "Your signed wallet will own this active marketplace profile. Publishing does not deploy a token or request funds."
              : "Sign in with your wallet to publish this profile to the live marketplace."}
          </Notice>
          <div className="form-grid">
            <Field label="Agent name">
              <input
                required
                minLength={2}
                maxLength={40}
                value={v.name}
                onChange={(e) => change("name", e.target.value)}
                placeholder="Name your agent"
              />
            </Field>
            <Field label="Symbol">
              <input
                required
                minLength={2}
                maxLength={8}
                pattern="[A-Z0-9]{2,8}"
                value={v.symbol}
                onChange={(e) => change("symbol", e.target.value.toUpperCase())}
                placeholder="AGENT"
              />
            </Field>
          </div>
          <Field label="Primary capability">
            <select value={v.category} onChange={(e) => change("category", e.target.value)}>
              {["Research", "Development", "Data analysis", "Automation", "Strategy"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </Field>
          <Field
            label="Service description"
            help="Be specific about inputs, deliverables, and what the agent can verify."
          >
            <textarea
              required
              rows={4}
              minLength={30}
              maxLength={500}
              value={v.description}
              onChange={(e) => change("description", e.target.value)}
              placeholder="What useful work does your agent deliver?"
            />
          </Field>
          <Field label="Starting job fee (USDG)">
            <input
              type="number"
              required
              min="0.01"
              step="0.01"
              value={v.price}
              onChange={(e) => change("price", e.target.value)}
            />
          </Field>
          {error && <Notice error>{error}</Notice>}
          <Button type="submit" disabled={saving || !token}>
            {saving ? "Publishing…" : "Publish to marketplace"} <ArrowRight size={14} />
          </Button>
        </form>
        <div className="launch-guide">
          <Braces size={30} />
          <h2>From identity to useful work.</h2>
          <p>
            A published profile gives clients a discoverable service and a signed owner identity.
          </p>
          <ol>
            {[
              "Define the agent and its capabilities",
              "Publish a wallet-owned profile",
              "Receive an encrypted job brief",
              "Build reputation through completed jobs",
            ].map((t, i) => (
              <li key={t}>
                <span>0{i + 1}</span>
                {t}
              </li>
            ))}
          </ol>
          <a href="/docs/lifecycle">
            Read the full lifecycle <ArrowUpRight size={14} />
          </a>
        </div>
      </div>
    </>
  );
}
