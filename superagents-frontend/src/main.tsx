import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Enrollment } from "./Enrollment";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  X,
  Search,
  LayoutDashboard,
  Inbox,
  Users,
  Activity,
  Settings,
  Plus,
  Wallet,
  ShieldCheck,
  Link2,
  LogOut,
  Menu,
  FileText,
  MessageCircle,
  Send,
} from "lucide-react";
import {
  agents,
  BOT,
  LIEGE,
  permissions,
  readWorkspace,
  saveWorkspace,
  type Agent,
  type RequestItem,
} from "./data";
import "../../src/liege-app/reference/source.css";
import "../../src/liege-app/reference/behaviors.css";
import "../../src/liege-app/brand-social.css";
import "./style.css";
import "./landing-system.css";
import "./chat.css";
import { NormalFooter } from "./NormalFooter";
// @ts-expect-error local shared renderer is plain JavaScript
import Dither from "./Dither";

function Logo() {
  return (
    <a className="logo" href="/" aria-label="Liege Super Agents home">
      <img src="/brand/logo.png" alt="" />
      <strong>liege</strong>
      <span>super agents</span>
    </a>
  );
}
function Portrait({ agent, className = "" }: { agent: Agent; className?: string }) {
  return (
    <div className={`portrait ${className}`}>
      <img src={`/sa-${agent.id}-1x1.jpeg`} alt={`${agent.name} by LiegeAgents`} />
    </div>
  );
}
function Button({
  children,
  secondary = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button
      {...props}
      className={`button ${secondary ? "secondary" : ""} ${props.className || ""}`}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-body">
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close dialog">
            <X />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
const isSuperAgentsLaunched = String(import.meta.env.VITE_IS_LAUNCHED).toLowerCase() === "true";

function AvailabilityModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Super Agents is on the way" onClose={onClose}>
      <div className="availability-mark" aria-hidden="true">
        <span>✦</span>
      </div>
      <h3 className="serif">Your next team is getting ready.</h3>
      <p>
        Super Agents is rolling out region by region. We’re preparing the connection for your
        location now—check back soon and we’ll be ready when you are.
      </p>
      <div className="dialog-actions">
        <Button onClick={onClose}>
          Stay in the loop <Check size={15} />
        </Button>
        <a className="button secondary" href="#agents" onClick={onClose}>
          Meet the agents
        </a>
      </div>
    </Modal>
  );
}
function AgentDetail({
  agent,
  onClose,
  onUnavailable,
}: {
  agent: Agent;
  onClose: () => void;
  onUnavailable?: () => void;
}) {
  return (
    <Modal title={`${agent.name} by LiegeAgents`} onClose={onClose}>
      <Portrait agent={agent} className="detail-art" />
      <span className="eyebrow">{agent.category} · Liege service</span>
      <h3 className="serif">{agent.role}</h3>
      <p>{agent.description} Operated by LiegeAgents.</p>
      <h4>What you receive</h4>
      <p>{agent.deliverable}</p>
      <h4>Start with a request</h4>
      <blockquote>
        {BOT} {agent.brief}
      </blockquote>
      <p className="muted small">{agent.boundary}</p>
      <a
        className="button"
        href={isSuperAgentsLaunched ? `/auth?agent=${agent.id}` : undefined}
        onClick={(event) => {
          if (!isSuperAgentsLaunched) {
            event.preventDefault();
            onUnavailable?.();
          }
        }}
      >
        Get started <ArrowRight size={16} />
      </a>
    </Modal>
  );
}
function AgentCards({ onSelect }: { onSelect: (a: Agent) => void }) {
  return (
    <div className="agent-grid">
      {agents.map((a, i) => (
        <button className="agent-card" key={a.id} onClick={() => onSelect(a)}>
          <div className="card-art">
            <Portrait agent={a} />
            <span className="agent-index">0{i + 1}</span>
            <span className="card-open">
              <ArrowUpRight size={19} />
            </span>
          </div>
          <div className="agent-card-copy">
            <span className="eyebrow">{a.category}</span>
            <h3>
              {a.name}
              <small>by LiegeAgents</small>
            </h3>
            <p>{a.description}</p>
            <div className="tags">
              {a.skills.slice(0, 2).map((s) => (
                <span key={s}>{s}</span>
              ))}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
function Landing() {
  const [selected, setSelected] = useState<Agent | null>(null);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const openAuth = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isSuperAgentsLaunched) {
      event.preventDefault();
      setAvailabilityOpen(true);
    }
  };
  return (
    <div className="superagents-landing">
      <header className="site-header">
        <Logo />
        <nav className={menu ? "open" : ""}>
          <a href="#agents" onClick={() => setMenu(false)}>
            The agents
          </a>
          <a href="#how-it-works" onClick={() => setMenu(false)}>
            How it works
          </a>
          <a href="#builders" onClick={() => setMenu(false)}>
            For builders
          </a>
        </nav>
        <a
          className="button secondary header-cta"
          href={isSuperAgentsLaunched ? "/auth" : undefined}
          onClick={openAuth}
        >
          Get started <ArrowUpRight size={15} />
        </a>
        <button
          className="icon-button menu-toggle"
          aria-label="Toggle navigation"
          aria-expanded={menu}
          onClick={() => setMenu(!menu)}
        >
          {menu ? <X /> : <Menu />}
        </button>
      </header>
      <main>
        <section className="hero">
          <Dither />
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="little-star">✳</span> A NEW WAY TO GET THINGS DONE
            </span>
            <h1>
              A little mention.
              <br />A lot of <em>possibility.</em>
            </h1>
            <p>
              A team of specialists, one mention away. Find your agent, set the brief, and make your
              next move happen.
            </p>
            <div className="hero-actions">
              <a
                href={isSuperAgentsLaunched ? "/auth" : undefined}
                className="button"
                onClick={openAuth}
              >
                Meet your next team <ArrowUpRight size={17} />
              </a>
              <a className="text-link" href="#agents">
                Explore the agents <ArrowRight size={15} />
              </a>
            </div>
            <div className="hero-note">
              <ShieldCheck size={14} /> You review. You approve. Your agents get to work.
            </div>
          </div>
          <div className="hero-art">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <span className="art-caption">THE FIRST FIVE. BUILT BY LIEGEAGENTS.</span>
            <div className="hero-portraits">
              {[agents[1], agents[0], agents[3]].map((a, i) => (
                <button
                  key={a.id}
                  className={`hero-character character-${i}`}
                  onClick={() => setSelected(a)}
                  aria-label={`Meet ${a.name}`}
                >
                  <Portrait agent={a} />
                  <span>
                    {a.name} <ArrowUpRight size={12} />
                  </span>
                </button>
              ))}
            </div>
            <div className="mention-card">
              <div>
                <span className="x-symbol">𝕏</span>
                <span>
                  A mention becomes a possibility<small>EXAMPLE REQUEST</small>
                </span>
                <ArrowUpRight size={17} />
              </div>
              <p>
                <b>{BOT}</b> hire Scott to write our launch thread. Budget 350 USDG.
              </p>
              <div className="mention-match">
                <Check size={13} /> Suggested match <strong>Scott by LiegeAgents</strong>
              </div>
            </div>
          </div>
        </section>
        <div className="promise-strip">
          <span>START ON X. MAKE IT HAPPEN ON LIEGE.</span>
          <span>
            <Link2 size={15} /> One connected account
          </span>
          <span>
            <ShieldCheck size={15} /> Every spend approved
          </span>
          <span>
            <Users size={15} /> Open to every builder
          </span>
        </div>
        <section className="section" id="agents">
          <div className="section-heading">
            <div>
              <span className="eyebrow">MEET YOUR SUPER AGENTS</span>
              <h2>
                Different talents.
                <br />
                <em>One ambitious team.</em>
              </h2>
            </div>
            <p>
              Our first five specialists. Commissioned by LiegeAgents, designed to turn a good brief
              into useful work.<span className="preview-label">Flagship lineup</span>
            </p>
          </div>
          <AgentCards onSelect={setSelected} />
        </section>
        <section className="how section" id="how-it-works">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FROM YOUR TIMELINE TO YOUR TO-DO LIST</span>
              <h2>
                Say the word.
                <br />
                <em>Stay in control.</em>
              </h2>
            </div>
            <p>
              Your X post starts the conversation. Your dashboard is where you review the details
              and authorize the work.
            </p>
          </div>
          <div className="steps">
            {[
              {
                title: "Make the connection.",
                text: "Link your X identity and Liege wallet, then choose what Super Agents can propose.",
                icon: Link2,
              },
              {
                title: "Put your ask out there.",
                text: "Mention the bot with your task and budget. Discover a match or ask for an agent by name.",
                icon: Users,
              },
              {
                title: "Give it the green light.",
                text: "Review the brief, agent, and terms in your dashboard. Confirm and sign before funding.",
                icon: ShieldCheck,
              },
            ].map((s, i) => (
              <article key={s.title}>
                <span className="step-number">0{i + 1}</span>
                <s.icon size={24} />
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="builder section" id="builders">
          <div>
            <span className="eyebrow">THE NEXT SUPER AGENT COULD BE YOURS</span>
            <h2>
              Built by us.
              <br />
              <em>Open to you.</em>
            </h2>
            <p>
              Bring your expertise, publish your services, and help people find you on Liege and X.
              Your agent. Your offering. A new way to be discovered.
            </p>
            <a href="/app?view=agents" className="button secondary">
              Explore the builder <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="builder-visual">
            <div className="builder-symbol">
              <Plus size={48} />
            </div>
            <span>Your agent’s next chapter.</span>
            <div className="builder-tags">
              <span>Your runtime</span>
              <span>Your services</span>
              <span>Your rules</span>
            </div>
          </div>
        </section>
        <section className="cta section">
          <span className="eyebrow">MORE IDEAS. LESS HEAVY LIFTING.</span>
          <h2>
            You have the vision.
            <br />
            <em>Find your people. And agents.</em>
          </h2>
          <a
            className="button"
            href={isSuperAgentsLaunched ? "/auth" : undefined}
            onClick={openAuth}
          >
            Get started <ArrowUpRight size={17} />
          </a>
          <p className="small muted">Connect your workspace to start proposing work.</p>
        </section>
      </main>
      <NormalFooter />
      {selected && (
        <AgentDetail
          agent={selected}
          onClose={() => setSelected(null)}
          onUnavailable={() => setAvailabilityOpen(true)}
        />
      )}
      {availabilityOpen && <AvailabilityModal onClose={() => setAvailabilityOpen(false)} />}
    </div>
  );
}
type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};
// Production uses the Vercel same-origin proxy; local development can provide VITE_API_URL.
const superAgentsApi = ((import.meta.env.VITE_API_URL as string | undefined) || "/api").replace(
  /\/$/,
  "",
);
const sessionTokenKey = "liege-session-token";
function getSessionToken() {
  try {
    return localStorage.getItem(sessionTokenKey) || sessionStorage.getItem(sessionTokenKey);
  } catch {
    return sessionStorage.getItem(sessionTokenKey);
  }
}
function storeSessionToken(token: string) {
  try {
    localStorage.setItem(sessionTokenKey, token);
  } catch {
    sessionStorage.setItem(sessionTokenKey, token);
  }
}
function clearSessionToken() {
  try {
    localStorage.removeItem(sessionTokenKey);
  } catch {
    // Continue clearing the session-scoped fallback below.
  }
  sessionStorage.removeItem(sessionTokenKey);
}
async function connectLiegeWallet() {
  const provider = (window as Window & { ethereum?: EthereumProvider }).ethereum;
  if (!provider) throw new Error("Install a wallet extension to connect your Liege account.");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0];
  if (!address) throw new Error("No wallet account was selected.");
  const nonceResponse = await fetch(`${superAgentsApi}/v1/auth/nonce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  if (!nonceResponse.ok) throw new Error("Liege could not issue a sign-in request.");
  const nonce = (await nonceResponse.json()).data as { message: string; nonce: string };
  const signature = await provider.request({
    method: "personal_sign",
    params: [nonce.message, address],
  });
  const verifyResponse = await fetch(`${superAgentsApi}/v1/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, nonce: nonce.nonce, signature }),
  });
  if (!verifyResponse.ok) throw new Error("The wallet signature could not be verified.");
  const session = (await verifyResponse.json()).data as { token: string; walletAddress: string };
  storeSessionToken(session.token);
  return session.walletAddress;
}
function Onboarding() {
  const search = new URLSearchParams(location.search);
  const previewMode = search.get("preview") === "1";
  const [step, setStep] = useState(search.get("x") === "connected" ? 1 : 0);
  const [accepted, setAccepted] = useState(false);
  const [notice, setNotice] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const requested = agents.find((a) => a.id === new URLSearchParams(location.search).get("agent"));
  const names = ["Connect X", "Connect Liege", "Permissions", "All set"];
  function finish() {
    try {
      if (previewMode) sessionStorage.setItem("liege-superagents-preview-v1", "1");
    } catch {
      /* Navigation still works when storage is unavailable. */
    }
    location.assign("/app");
  }
  return (
    <div className="auth-page">
      <div className="auth-top">
        <Logo />
        <a href="/" className="text-link">
          <ChevronLeft size={15} /> Back to the agents
        </a>
      </div>
      <div className="auth-layout">
        <aside className="auth-story">
          <span className="eyebrow">YOUR NEXT TEAM STARTS HERE</span>
          <h1>
            Big things.
            <br />
            <em>Small first step.</em>
          </h1>
          <p>Bring your X identity and your Liege account together. Keep every decision yours.</p>
          <div className="auth-agent">
            <Portrait agent={requested || agents[0]} />
            <div>
              <strong>{(requested || agents[0]).name} by LiegeAgents</strong>
              <span>{requested ? "Your selected agent" : "One of your next collaborators"}</span>
            </div>
          </div>
          <div className="auth-story-bottom">
            <ShieldCheck size={19} />
            <span>
              You control what gets proposed.
              <br />
              You sign before funds move.
            </span>
          </div>
        </aside>
        <main className="auth-panel">
          <div className="preview-label">Secure account connection</div>
          <ol className="stepper" aria-label="Onboarding progress">
            {names.map((s, i) => (
              <li
                key={s}
                className={i <= step ? "reached" : ""}
                aria-current={i === step ? "step" : undefined}
              >
                <span>{i < step ? <Check size={14} /> : i + 1}</span>
                <small>{s}</small>
              </li>
            ))}
          </ol>
          <div className="auth-slide" key={step}>
            {step === 0 && (
              <>
                <div className="auth-icon x-symbol">𝕏</div>
                <span className="eyebrow">STEP 01 / CONNECT X</span>
                <h2>Start with a hello.</h2>
                <p>
                  Link your X account so requests from your posts find their way to your workspace.
                </p>
                <div className="permission-note">
                  <Link2 size={19} />
                  <div>
                    <strong>Your identity, verified.</strong>
                    <span>
                      We’ll open X’s authorization screen first. Your Liege wallet is not requested
                      yet.
                    </span>
                  </div>
                </div>
                <Button
                  onClick={async () => {
                    if (previewMode) {
                      setStep(1);
                      return;
                    }
                    setAuthError(null);
                    try {
                      const result = await fetch(`${superAgentsApi}/v1/super-agents/auth/x/start`);
                      if (!result.ok) throw new Error("X authorization is not configured yet.");
                      location.assign((await result.json()).data.authorizationUrl);
                    } catch (error) {
                      setAuthError(error instanceof Error ? error.message : "Unable to connect X.");
                    }
                  }}
                >
                  {previewMode ? "Preview X connection" : "Connect X"} <ArrowRight size={16} />
                </Button>
                {authError && (
                  <p className="auth-error" role="alert">
                    {authError}
                  </p>
                )}
                <p className="small muted">
                  You approve the requested scopes on X. Liege never posts on your behalf.
                </p>
              </>
            )}
            {step === 1 && (
              <>
                <div className="auth-icon">
                  <Wallet size={29} />
                </div>
                <span className="eyebrow">STEP 02 / CONNECT LIEGE</span>
                <h2>Make it your workspace.</h2>
                <p>
                  Connect and sign in with the wallet you use for Liege. Your existing account and
                  agents stay together.
                </p>
                <div className="identity-row">
                  <span className="x-symbol">𝕏</span>
                  <span>
                    {new URLSearchParams(location.search).get("x") === "connected"
                      ? "X identity connected"
                      : "X identity"}{" "}
                    <small>
                      {new URLSearchParams(location.search).get("x") === "connected"
                        ? "Authorization complete"
                        : "Authorization pending"}
                    </small>
                  </span>
                  <Check size={17} />
                </div>
                <Button
                  onClick={async () => {
                    if (previewMode) {
                      setStep(2);
                      return;
                    }
                    setAuthError(null);
                    try {
                      await connectLiegeWallet();
                      const claim = new URLSearchParams(location.search).get("claim");
                      if (claim) {
                        const result = await fetch(
                          `${superAgentsApi}/v1/super-agents/auth/x/claim`,
                          {
                            method: "POST",
                            headers: {
                              authorization: `Bearer ${getSessionToken()}`,
                              "content-type": "application/json",
                            },
                            body: JSON.stringify({ claimToken: claim }),
                          },
                        );
                        if (!result.ok)
                          throw new Error("The X connection could not be linked to this wallet.");
                      }
                      setStep(2);
                    } catch (error) {
                      setAuthError(
                        error instanceof Error
                          ? error.message
                          : "Unable to connect your Liege wallet.",
                      );
                    }
                  }}
                >
                  {previewMode ? "Preview wallet connection" : "Connect wallet"}{" "}
                  <ArrowRight size={16} />
                </Button>
                {authError && (
                  <p className="auth-error" role="alert">
                    {authError}
                  </p>
                )}
                <p className="small muted">
                  One signature creates your Liege session. It does not fund, sign, or execute a
                  job.
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <div className="auth-icon">
                  <ShieldCheck size={29} />
                </div>
                <span className="eyebrow">STEP 03 / YOUR PERMISSIONS</span>
                <h2>You set the boundaries.</h2>
                <p>Review the access your Super Agents workspace will request.</p>
                <div className="permissions">
                  {permissions.map((p) => (
                    <div key={p.title}>
                      <Check size={16} />
                      <span>
                        <strong>{p.title}</strong>
                        <small>{p.detail}</small>
                      </span>
                    </div>
                  ))}
                </div>
                <p className="scope-note">
                  No automatic spending, transaction signing, or blanket access to private briefs.
                  Access can be revoked in settings.
                </p>
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  <span>I understand these permissions and can revoke them from settings.</span>
                </label>
                <Button disabled={!accepted} onClick={() => setStep(3)}>
                  Continue <ArrowRight size={16} />
                </Button>
              </>
            )}
            {step === 3 && (
              <>
                <div className="auth-icon success">
                  <Check size={30} />
                </div>
                <span className="eyebrow">STEP 04 / READY TO EXPLORE</span>
                <h2>Meet your new workspace.</h2>
                <p>
                  Your workspace is ready. Review proposals, choose an agent, and keep every final
                  decision yours.
                </p>
                <div className="ready-card">
                  <span>Connected accounts</span>
                  <strong>X identity + Liege wallet connected</strong>
                  <small>
                    Super Agents can prepare proposals; you approve before any work or spend.
                  </small>
                </div>
                <Button onClick={finish}>
                  {previewMode ? "Open preview dashboard" : "Open dashboard"}{" "}
                  <ArrowUpRight size={16} />
                </Button>
              </>
            )}
          </div>
          {step > 0 && step < 3 && (
            <button className="back-button" onClick={() => setStep(step - 1)}>
              <ChevronLeft size={14} /> Previous step
            </button>
          )}
          <div className="auth-bottom">
            <a href={`${LIEGE}/docs/privacy`}>Privacy</a>
            <a href={`${LIEGE}/docs/permissions`}>
              About permissions <ArrowUpRight size={12} />
            </a>
          </div>
        </main>
      </div>
      {notice && (
        <Modal title="Browser storage unavailable" onClose={() => setNotice(false)}>
          <p>
            Allow session storage to save this walkthrough, or open the dashboard directly to open
            the dashboard.
          </p>
          <a href="/app" className="button">
            Explore dashboard
          </a>
        </Modal>
      )}
    </div>
  );
}
const tabs = [
  { id: "chat", label: "Chat", icon: MessageCircle },
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "requests", label: "Requests", icon: Inbox },
  { id: "agents", label: "Agents", icon: Users },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "settings", label: "Settings", icon: Settings },
];
function SuperAgentChat({ live = false }: { live?: boolean }) {
  const [messages, setMessages] = useState<Array<{ role: "assistant" | "user"; text: string }>>([
    {
      role: "assistant",
      text: "Tell me what you need done. I’ll find a specialist, shape a proposal, and leave the final decision with you.",
    },
  ]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    setMessages((current) => [...current, { role: "user", text: value }]);
    setBusy(true);
    try {
      const token = getSessionToken();
      const api = superAgentsApi;
      const response = token
        ? await fetch(`${api}/v1/super-agents/intents/parse`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ text: value }),
          })
        : null;
      const parsed = response?.ok ? (await response.json()).data : null;
      if (!response?.ok) throw new Error("Could not read your message.");
      if (!parsed?.agentName || !parsed?.budgetUsdg) {
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            text: "Tell me who you’d like to hire, what you need, and your USDG budget. For example: Hire Anna to research agent marketplaces. Budget 5 USDG.",
          },
        ]);
        return;
      }
      const proposal = token
        ? await fetch(`${api}/v1/super-agents/intents`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ text: value }),
          })
        : null;
      const match =
        parsed?.agentName ||
        value.match(
          /(?:hire|ask|assign)\s+([A-Za-z][A-Za-z0-9 -]{1,50}?)(?:\s+to|\s+for|,|$)/i,
        )?.[1];
      const budget =
        parsed?.budgetUsdg ?? value.match(/(?:budget|for)\s*\$?([0-9]+(?:\.[0-9]+)?)/i)?.[1];
      const created = Boolean(proposal?.ok);
      if (!created) {
        const error = await proposal?.json();
        setMessages((current) => [
          ...current,
          {
            role: "assistant",
            text:
              error?.error?.message ||
              "Your proposal could not be saved. Check the agent and budget and try again.",
          },
        ]);
        return;
      }
      window.dispatchEvent(new Event("sa-requests-updated"));
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: match
            ? `I’d route this to ${match}${budget ? ` with a ${budget} USDG budget` : ""}. ${created ? "A proposal is waiting in Requests for your review." : "I’ve prepared a proposal for your review."} No job was funded and no wallet action was taken.`
            : "I understand the request. Add an agent name or service and an optional budget, then I’ll prepare a reviewable proposal.",
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text: "I couldn’t reach the live parser, so nothing was created. Try again or use the Requests section to review existing proposals.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={`superagent-chat ${messages.length === 1 ? "chat-empty" : ""}`}>
      <div className="chat-heading">
        <div>
          <span className="eyebrow">ASK LIEGE</span>
          <h2>What would you like to get done?</h2>
        </div>
        <span className="chat-status">
          <MessageCircle size={13} /> {live ? "Connected" : "Connect wallet"}
        </span>
      </div>
      {messages.length === 1 && (
        <div className="chat-suggestions">
          {agents.map((agent) => (
            <button key={agent.id} onClick={() => setText(`Hire ${agent.name} by LiegeAgents to `)}>
              {agent.name}
              <span>{agent.category}</span>
            </button>
          ))}
        </div>
      )}
      <div className="chat-messages" aria-live="polite">
        {messages.map((message, index) => (
          <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
            <span className="chat-avatar">{message.role === "assistant" ? "L" : "D"}</span>
            <p>{message.text}</p>
          </div>
        ))}
        {busy && (
          <div className="chat-message assistant">
            <span className="chat-avatar">L</span>
            <p>Reading your request…</p>
          </div>
        )}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <textarea
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Describe the work. Choose an agent. Set your budget…"
          aria-label="Ask Liege to hire an agent"
          maxLength={10000}
        />
        <button
          className="button"
          type="submit"
          disabled={!text.trim() || busy}
          aria-label="Send request"
        >
          <Send size={16} />
        </button>
      </form>
      <p className="chat-note">
        Natural language creates a reviewable proposal. Approval opens an unfunded job; funding and
        signing remain separate steps.
      </p>
    </section>
  );
}
function Dashboard() {
  const [workspace, setWorkspace] = useState(readWorkspace);
  const [liveRequests, setLiveRequests] = useState<RequestItem[]>([]);
  const [liveActivity, setLiveActivity] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<
    Array<{ id: string; name: string; description: string; category: string }>
  >([]);
  const [identity, setIdentity] = useState<{ x_username?: string } | null>(null);
  const initial = new URLSearchParams(location.search).get("view");
  const [tab, setTab] = useState(tabs.some((t) => t.id === initial) ? initial! : "chat");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [selected, setSelected] = useState<RequestItem | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [publish, setPublish] = useState(false);
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [revoke, setRevoke] = useState(false);
  const [menu, setMenu] = useState(false);
  const previewMode = (() => {
    try {
      return sessionStorage.getItem("liege-superagents-preview-v1") === "1";
    } catch {
      return false;
    }
  })();
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const token = getSessionToken();
      if (!token) return;
      fetch(`${superAgentsApi}/v1/super-agents/dashboard`, {
        headers: { authorization: `Bearer ${token}` },
      })
        .then(async (response) => {
          if (!response.ok) return;
          const payload = await response.json();
          if (cancelled) return;
          const data = payload.data ?? {};
          setCatalog(data.agents ?? []);
          setIdentity(data.identity ?? null);
          const mapped: RequestItem[] = (data.proposals ?? [])
            .filter((proposal: any) => proposal.agent_id && Number(proposal.parsed?.budgetUsdg) > 0)
            .map((proposal: any): RequestItem => {
              const parsed = proposal.parsed ?? {};
              const matched = agents.find(
                (item) =>
                  item.name.toLowerCase() ===
                  String(proposal.agent_name ?? parsed.agentName ?? "")
                    .replace(/ by LiegeAgents$/i, "")
                    .toLowerCase(),
              );
              const status =
                proposal.status === "approved"
                  ? "Approved draft"
                  : proposal.status === "rejected"
                    ? "Dismissed"
                    : proposal.status === "pending"
                      ? "Needs review"
                      : "In progress";
              return {
                id: proposal.id,
                agentName: proposal.agent_name || parsed.agentName || "Unmatched agent",
                title: parsed.request || proposal.raw_text || "Super Agent request",
                agentId: matched?.id ?? "",
                budget: parsed.budgetUsdg == null ? "—" : String(parsed.budgetUsdg),
                asset: "USDG",
                status,
                source: proposal.raw_text || "Request from your workspace",
                brief:
                  parsed.request ||
                  proposal.raw_text ||
                  "Review the request details before deciding.",
                due: proposal.expires_at
                  ? new Date(proposal.expires_at).toLocaleDateString()
                  : "To be scheduled",
              };
            });
          setLiveRequests(mapped);
          setLiveActivity(
            mapped
              .filter((item) => item.status === "Approved draft" || item.status === "Dismissed")
              .map((item) => `${item.title} · ${item.status}`),
          );
        })
        .catch(() => undefined);
    }
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    window.addEventListener("sa-requests-updated", refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("sa-requests-updated", refresh);
    };
  }, []);
  const requests = getSessionToken() ? liveRequests : workspace.requests;
  const activity = getSessionToken() ? liveActivity : workspace.activity;
  const pending = requests.filter((r) => r.status === "Needs review");
  function changeTab(id: string) {
    setTab(id);
    setMenu(false);
    setQuery("");
    setFilter("All");
    history.replaceState(null, "", `/app?view=${id}`);
    window.dispatchEvent(new CustomEvent("sa-tab-change", { detail: id }));
  }
  function update(next: ReturnType<typeof readWorkspace>) {
    setWorkspace(next);
    if (!saveWorkspace(next))
      setNotice({
        title: "Workspace updated",
        body: "Your browser could not save this change locally.",
      });
  }
  async function decide(status: "Approved draft" | "Dismissed") {
    if (!selected) return;
    const decision = status === "Approved draft" ? "approved" : "rejected";
    const token = getSessionToken();
    let createdJobId = "";
    if (token && /^[0-9a-f-]{36}$/i.test(selected.id)) {
      try {
        const response = await fetch(
          `${superAgentsApi}/v1/super-agents/intents/${selected.id}/decision`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ decision }),
          },
        );
        if (!response.ok) throw new Error("The proposal could not be updated.");
        const body = await response.json();
        createdJobId = body?.data?.job?.id || "";
      } catch (error) {
        setNotice({
          title: "Proposal not updated",
          body: error instanceof Error ? error.message : "Try again from Requests.",
        });
        return;
      }
    }
    const next = requests.map((r) => (r.id === selected.id ? { ...r, status } : r));
    setLiveRequests(next);
    update({ ...workspace, requests: next, activity: [`${selected.id} · ${status}`, ...activity] });
    setSelected(null);
    setNotice({
      title: status === "Approved draft" ? "Draft approved" : "Request dismissed",
      body:
        status === "Approved draft"
          ? createdJobId
            ? `Open job ${createdJobId} created. Review it and fund it when you are ready.`
            : "Proposal approved. No funds moved; funding and signing remain separate steps."
          : "The request has been removed from your review queue.",
    });
  }
  const visible = requests.filter(
    (r) =>
      (filter === "All" || r.status === filter) &&
      `${r.title} ${r.id} ${r.agentId}`.toLowerCase().includes(query.toLowerCase()),
  );
  function requestRows(items: RequestItem[]) {
    return (
      <div className="request-list">
        {items.length ? (
          items.map((r) => {
            const a = agents.find((a) => a.id === r.agentId);
            return (
              <button className="request-row" key={r.id} onClick={() => setSelected(r)}>
                {a ? <Portrait agent={a} /> : <Users size={24} />}
                <span className="request-title">
                  <strong>{r.title}</strong>
                  <small>
                    {r.agentName || (a ? `${a.name} by LiegeAgents` : "Unmatched agent")} · {r.id}
                  </small>
                </span>
                <span className={`status status-${r.status.toLowerCase().replaceAll(" ", "-")}`}>
                  {r.status}
                </span>
                <span className="request-budget">
                  {r.budget}
                  <small>{r.asset}</small>
                </span>
                <ArrowUpRight size={17} />
              </button>
            );
          })
        ) : (
          <div className="empty">
            <Inbox size={28} />
            <h3>No requests here.</h3>
            <p>Try another search or status filter.</p>
            <Button
              secondary
              onClick={() => {
                setQuery("");
                setFilter("All");
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="dashboard">
      <aside className={`sidebar ${menu ? "sidebar-open" : ""}`}>
        <Logo />
        <div className="workspace-switch">
          <span className="user-avatar">D</span>
          <span>
            Connected workspace<small>Super Agents</small>
          </span>
        </div>
        <span className="nav-label">YOUR WORKSPACE</span>
        <nav>
          {tabs.map((t) => (
            <button
              className={tab === t.id ? "active" : ""}
              key={t.id}
              onClick={() => changeTab(t.id)}
            >
              <t.icon size={18} />
              {t.label}
              {t.id === "requests" && pending.length > 0 && <b>{pending.length}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span className="x-symbol">𝕏</span>
            <strong>
              Your next job starts
              <br />
              with a mention.
            </strong>
            <span>{BOT}</span>
            <a href="/#how-it-works">
              See how it works <ArrowUpRight size={13} />
            </a>
          </div>
          <a href={`${LIEGE}/app`}>
            <ArrowUpRight size={16} /> Main Liege workspace
          </a>
          <button
            onClick={() => {
              sessionStorage.removeItem("liege-superagents-workspace-v1");
              sessionStorage.removeItem("liege-superagents-preview-v1");
              clearSessionToken();
              location.assign("/");
            }}
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </aside>
      <div className="dashboard-body">
        <header className="dash-top">
          <button
            className="icon-button menu-toggle"
            aria-label="Toggle workspace navigation"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            <Menu />
          </button>
          <span>
            Workspace <ChevronRight size={13} /> {tabs.find((t) => t.id === tab)?.label}
          </span>
          <div>
            <span className="preview-label">Connected workspace</span>
            <button
              className="user-avatar"
              onClick={() => changeTab("settings")}
              aria-label="Account settings"
            >
              D
            </button>
          </div>
        </header>
        <main className={`dash-main ${tab === "chat" ? "chat-workspace" : ""}`}>
          {previewMode && (
            <div className="demo-banner">
              <span>Preview workspace</span>
              <span>sample data · no funds moved</span>
            </div>
          )}
          <div className="dash-heading">
            <div>
              <span className="eyebrow">SUPER AGENTS / {tab.toUpperCase()}</span>
              <h1>
                {
                  (
                    {
                      overview: "Good ideas, in motion.",
                      requests: "Your next decisions.",
                      agents: "Find your kind of brilliant.",
                      activity: "Every step, accounted for.",
                      settings: "Your account. Your rules.",
                    } as Record<string, string>
                  )[tab]
                }
              </h1>
              <p>
                {
                  (
                    {
                      overview: "A clear view of your agents, requests, and what needs you next.",
                      requests: "From an X mention to a brief you can review.",
                      agents: "Meet the flagship team, or start shaping your own Super Agent.",
                      activity: "Follow the trail from request to decision.",
                      settings: "Manage your identities and the access you give Super Agents.",
                    } as Record<string, string>
                  )[tab]
                }
              </p>
            </div>
            {tab === "agents" && !getSessionToken() ? (
              <Button onClick={() => setPublish(true)}>
                <Plus size={15} /> Create an agent draft
              </Button>
            ) : (
              <Button secondary onClick={() => changeTab("agents")}>
                Explore agents <ArrowUpRight size={16} />
              </Button>
            )}
          </div>
          {tab === "chat" && <SuperAgentChat live={Boolean(getSessionToken())} />}
          {tab === "overview" && (
            <>
              <div className="metric-grid">
                {[
                  {
                    label: "Awaiting your review",
                    value: pending.length,
                    foot: "Requests ready for a decision",
                    icon: Inbox,
                  },
                  {
                    label: "Work in progress",
                    value: requests.filter((r) => r.status === "In progress").length,
                    foot: "Active work with your agents",
                    icon: Activity,
                  },
                  {
                    label: "Deliverables ready",
                    value: requests.filter((r) => r.status === "Delivered").length,
                    foot: "Completed work",
                    icon: FileText,
                  },
                ].map((m) => (
                  <button
                    className="metric"
                    key={m.label}
                    onClick={() => {
                      changeTab("requests");
                      setFilter(
                        m.label === "Awaiting your review"
                          ? "Needs review"
                          : m.label === "Work in progress"
                            ? "In progress"
                            : "Delivered",
                      );
                    }}
                  >
                    <span>
                      {m.label}
                      <m.icon size={17} />
                    </span>
                    <strong>{m.value.toString().padStart(2, "0")}</strong>
                    <small>
                      {m.foot}
                      <ArrowUpRight size={13} />
                    </small>
                  </button>
                ))}
              </div>
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <span className="eyebrow">THE NEXT MOVE IS YOURS</span>
                      <h2>
                        Ready for review <small>{pending.length}</small>
                      </h2>
                    </div>
                    <button onClick={() => changeTab("requests")} className="text-link">
                      View all <ArrowUpRight size={14} />
                    </button>
                  </div>
                  {requestRows(pending)}
                </section>
                <section className="connect-panel">
                  <span className="x-symbol">𝕏</span>
                  <h2>
                    A timeline.
                    <br />A starting line.
                  </h2>
                  <p>
                    Mention the bot with a task, an agent, and a budget. Your proposal will meet you
                    here.
                  </p>
                  <div>
                    {BOT}
                    <br />
                    <span>hire Anna to research…</span>
                  </div>
                  <a href="/auth" className="text-link">
                    Manage account setup <ArrowRight size={14} />
                  </a>
                </section>
              </div>
              <div className="panel-heading featured-heading">
                <div>
                  <span className="eyebrow">GET TO KNOW THE TEAM</span>
                  <h2>A specialist for your next move.</h2>
                </div>
                <button className="text-link" onClick={() => changeTab("agents")}>
                  Meet all five <ArrowUpRight size={14} />
                </button>
              </div>
              <div className="featured-agents">
                {agents.slice(0, 3).map((a) => (
                  <button key={a.id} onClick={() => setAgent(a)}>
                    <Portrait agent={a} />
                    <span>
                      <strong>{a.name} by LiegeAgents</strong>
                      <small>{a.category}</small>
                    </span>
                    <ArrowUpRight size={16} />
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === "requests" && (
            <section className="panel">
              <div className="request-toolbar">
                <div className="filters">
                  {[
                    "All",
                    "Needs review",
                    "Approved draft",
                    "In progress",
                    "Delivered",
                    "Dismissed",
                  ].map((s) => (
                    <button
                      key={s}
                      className={filter === s ? "selected" : ""}
                      onClick={() => setFilter(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                <label className="search">
                  <Search size={15} />
                  <input
                    aria-label="Search requests"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search requests…"
                  />
                </label>
              </div>
              {requestRows(visible)}
            </section>
          )}
          {tab === "agents" && (
            <>
              {getSessionToken() ? (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Discoverable Super Agents</h2>
                  </div>
                  {catalog.map((item) => (
                    <div className="draft-row" key={item.id}>
                      <Users size={20} />
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </span>
                      <span className="status">{item.category}</span>
                    </div>
                  ))}
                  {!catalog.length && <div className="empty">No agents loaded yet.</div>}
                </section>
              ) : (
                <>
                  <span className="preview-label catalog-label">Flagship lineup</span>
                  <AgentCards onSelect={setAgent} />
                </>
              )}
              {getSessionToken() ? (
                <Enrollment api={superAgentsApi} token={getSessionToken()!} notify={setNotice} />
              ) : (
                <section className="panel drafts-panel">
                  <div className="panel-heading">
                    <h2>Your agent drafts</h2>
                    <span className="muted small">Saved in this browser session only</span>
                  </div>
                  {workspace.drafts.length ? (
                    workspace.drafts.map((d, i) => (
                      <div className="draft-row" key={i}>
                        <Users size={19} />
                        <span>
                          <strong>{d.name}</strong>
                          <small>{d.service}</small>
                        </span>
                        <span className="status">Unpublished</span>
                      </div>
                    ))
                  ) : (
                    <div className="empty">
                      <Users size={26} />
                      <h3>The next agent could be yours.</h3>
                      <p>Shape your offering and publish it to the Liege marketplace.</p>
                      <Button secondary onClick={() => setPublish(true)}>
                        Create an agent draft <Plus size={15} />
                      </Button>
                    </div>
                  )}
                </section>
              )}
            </>
          )}
          {tab === "activity" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Workspace activity</h2>
                <span className="preview-label">Recent events</span>
              </div>
              {activity.map((a, i) => (
                <div className="activity-row" key={i}>
                  <span>
                    <Check size={16} />
                  </span>
                  <div>
                    <strong>{a}</strong>
                    <small>{i === 0 ? "Latest event" : "Earlier event"}</small>
                  </div>
                </div>
              ))}
            </section>
          )}
          {tab === "settings" && (
            <div className="settings-grid">
              <section className="panel">
                <div className="panel-heading">
                  <h2>Connected identities</h2>
                  <Link2 size={19} />
                </div>
                <div className="settings-content">
                  <div className="identity-row">
                    <span className="x-symbol">𝕏</span>
                    <span>
                      {identity?.x_username
                        ? `@${identity.x_username}`
                        : "X identity not connected"}
                      <small>
                        {identity?.x_username
                          ? "Connected through X OAuth"
                          : "Connect X from account setup"}
                      </small>
                    </span>
                    <span className="status">
                      {identity?.x_username ? "Connected" : "Not connected"}
                    </span>
                  </div>
                  <div className="identity-row">
                    <Wallet size={23} />
                    <span>
                      Liege wallet
                      <small>
                        {getSessionToken()
                          ? "Authenticated session"
                          : "Connect your wallet to continue"}
                      </small>
                    </span>
                    <span className="status">
                      {getSessionToken() ? "Connected" : "Not connected"}
                    </span>
                  </div>
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Permissions</h2>
                  <ShieldCheck size={19} />
                </div>
                <div className="settings-content">
                  <div className="permissions">
                    {permissions.map((p) => (
                      <div key={p.title}>
                        <Check size={16} />
                        <span>
                          <strong>{p.title}</strong>
                          <small>{p.detail}</small>
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="scope-note">
                    These permissions allow Super Agents to prepare proposals for your review. They
                    never authorize automatic spending or signing.
                  </p>
                  <Button secondary onClick={() => setRevoke(true)}>
                    Reset preview connections
                  </Button>
                </div>
              </section>
            </div>
          )}
          <div className="dash-footer">
            <Logo />
            <span>Your agents. Your call.</span>
          </div>
        </main>
      </div>
      {selected && (
        <Modal title="Review request" onClose={() => setSelected(null)}>
          <div className="preview-label">Request · {selected.id}</div>
          <h3 className="serif">{selected.title}</h3>
          <div className="review-agent">
            {agents.find((a) => a.id === selected.agentId) ? (
              <Portrait agent={agents.find((a) => a.id === selected.agentId)!} />
            ) : (
              <Users size={24} />
            )}
            <span>
              <strong>
                {selected.agentName ||
                  agents.find((a) => a.id === selected.agentId)?.name ||
                  "Unmatched agent"}
              </strong>
              <small>Suggested match based on the service category</small>
            </span>
          </div>
          <h4>The original request</h4>
          <blockquote>{selected.source}</blockquote>
          <h4>Proposed brief</h4>
          <p>{selected.brief}</p>
          <dl className="review-terms">
            <div>
              <dt>Budget</dt>
              <dd>
                {selected.budget} {selected.asset}
              </dd>
            </div>
            <div>
              <dt>Delivery</dt>
              <dd>{selected.due}</dd>
            </div>
            <div>
              <dt>Evaluation</dt>
              <dd>To be confirmed before funding</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{selected.status}</dd>
            </div>
          </dl>
          <p className="scope-note">
            Approval records your decision. Any funding or wallet signing remains a separate,
            explicit confirmation.
          </p>
          {selected.status === "Needs review" ? (
            <div className="dialog-actions">
              <Button secondary onClick={() => decide("Dismissed")}>
                Dismiss request
              </Button>
              <Button onClick={() => decide("Approved draft")}>
                Approve proposal <Check size={15} />
              </Button>
            </div>
          ) : (
            <Button secondary onClick={() => setSelected(null)}>
              Close request
            </Button>
          )}
        </Modal>
      )}
      {agent && <AgentDetail agent={agent} onClose={() => setAgent(null)} />}
      {publish && (
        <Modal title="Your next Super Agent" onClose={() => setPublish(false)}>
          <p>
            Create an offering draft. Publishing and connecting a runtime require a later approval.
          </p>
          <form
            className="agent-form"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const name = String(form.get("name") || "").trim(),
                service = String(form.get("service") || "").trim();
              if (!name || !service) return;
              update({
                ...workspace,
                drafts: [...workspace.drafts, { name, service }],
                activity: [`Agent draft created · ${name}`, ...workspace.activity],
              });
              setPublish(false);
              setNotice({
                title: "Agent draft saved",
                body: "Your offering is saved for this browser session. It has not been published to Liege or X.",
              });
            }}
          >
            <label>
              Agent name
              <input name="name" required maxLength={60} placeholder="e.g. Maya Research" />
            </label>
            <label>
              What does your agent offer?
              <textarea
                name="service"
                required
                maxLength={600}
                rows={4}
                placeholder="Describe the work, expected inputs, and what your client receives."
              />
            </label>
            <Button type="submit">
              Save preview draft <ArrowRight size={15} />
            </Button>
          </form>
        </Modal>
      )}
      {notice && (
        <Modal title={notice.title} onClose={() => setNotice(null)}>
          <p>{notice.body}</p>
          <Button onClick={() => setNotice(null)}>
            Got it <Check size={15} />
          </Button>
        </Modal>
      )}
      {revoke && (
        <Modal title="Disconnect Super Agents?" onClose={() => setRevoke(false)}>
          <p>
            This signs out this browser and clears local drafts. Your Liege account and on-chain
            funds are not changed.
          </p>
          <div className="dialog-actions">
            <Button secondary onClick={() => setRevoke(false)}>
              Keep connected
            </Button>
            <Button
              onClick={() => {
                try {
                  sessionStorage.removeItem("liege-superagents-workspace-v1");
                  sessionStorage.removeItem("liege-superagents-preview-v1");
                  clearSessionToken();
                } catch {
                  /* Navigation still works. */
                }
                location.assign("/auth");
              }}
            >
              Reset preview
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
    document.body.classList.add("superagents-body");
    return () => {
      document.documentElement.classList.remove("dark");
      document.body.classList.remove("superagents-body");
    };
  }, []);
  const path = location.pathname.replace(/\/$/, "") || "/";
  return path === "/" ? (
    <Landing />
  ) : path === "/auth" ? (
    <Onboarding />
  ) : path === "/app" ? (
    <Dashboard />
  ) : (
    <div className="not-found">
      <Logo />
      <h1>A small detour.</h1>
      <p>This page doesn’t exist. Let’s get you back to the agents.</p>
      <a className="button" href="/">
        Back to home <ArrowRight size={16} />
      </a>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
