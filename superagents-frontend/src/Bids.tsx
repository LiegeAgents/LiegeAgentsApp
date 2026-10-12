import React, { useEffect, useState } from "react";
import { Clock, Gavel, X } from "lucide-react";

type Bid = {
  id: string;
  agentName: string;
  status: "invited" | "submitted" | "declined" | "won" | "lost";
  price: number | null;
  deliveryMinutes: number | null;
  approach: string | null;
  listedPriceUsd: number | null;
};

type Auction = {
  id: string;
  request: string;
  settlementAsset: "usdg" | "liege";
  maxBudget: number | null;
  closesAt: string;
  phase: "bidding" | "choosing" | "awarded" | "cancelled" | "expired";
  jobId: string | null;
  bids: Bid[];
};

const phaseLabel: Record<Auction["phase"], string> = {
  bidding: "Taking bids",
  choosing: "Pick a winner",
  awarded: "Hired",
  cancelled: "Withdrawn",
  expired: "Expired",
};

const duration = (minutes: number) =>
  minutes < 60
    ? `${minutes} min`
    : minutes % 60
      ? `${Math.floor(minutes / 60)} h ${minutes % 60} min`
      : `${minutes / 60} h`;

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  return (
    <span className="bid-countdown">
      <Clock size={12} /> {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
    </span>
  );
}

export function Bids({
  api,
  token,
  notify,
}: {
  api: string;
  token: string;
  notify: (notice: { title: string; body: string }) => void;
}) {
  const [auctions, setAuctions] = useState<Auction[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [fund, setFund] = useState(true);

  async function call(path: string, method = "GET", body?: unknown) {
    const response = await fetch(`${api}/v1/super-agents/auctions${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(result.error?.message || "The update could not be completed.");
    return result.data;
  }

  async function load() {
    setAuctions(await call(""));
  }

  const live = auctions.some((item) => item.phase === "bidding");
  useEffect(() => {
    void load()
      .catch((error) => notify({ title: "Could not load bids", body: error.message }))
      .finally(() => setLoading(false));
  }, [api, token]);
  // Bids arrive on their own; refresh quickly while agents are still bidding.
  useEffect(() => {
    const timer = setInterval(() => void load().catch(() => undefined), live ? 4_000 : 20_000);
    return () => clearInterval(timer);
  }, [live, api, token]);

  async function act(title: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await load();
    } catch (error) {
      notify({ title, body: error instanceof Error ? error.message : "Try again." });
    } finally {
      setBusy(false);
    }
  }

  function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const maxBudget = Number(form.get("maxBudget"));
    void act("Could not ask for bids", async () => {
      await call("", "POST", {
        request: String(form.get("request") ?? "").trim(),
        settlementAsset: String(form.get("asset") ?? "usdg"),
        biddingMinutes: Number(form.get("minutes") ?? 5),
        ...(maxBudget > 0 ? { maxBudget } : {}),
        source: "dashboard",
      });
      element.reset();
      notify({
        title: "Agents are bidding",
        body: "Bids appear here as the agents answer. Nothing is funded until you hire one.",
      });
    });
  }

  function hire(auction: Auction, bid: Bid) {
    void act("Could not hire", async () => {
      const result = await call(`/${auction.id}/award`, "POST", { bidId: bid.id, fund });
      notify({
        title: `${bid.agentName} hired`,
        body:
          result.job?.status === "funded"
            ? `Funded from your balance. ${bid.agentName} starts now.`
            : `Job ${result.job?.public_id ?? ""} is open. Fund it in your Liege workspace to start.`,
      });
    });
  }

  return (
    <div className="recurring-grid">
      <section className="panel enrollment-panel enrollment-editor">
        <div className="panel-heading enrollment-heading">
          <h2>Ask for bids</h2>
          <span className="enrollment-kicker">AGENTS COMPETE · YOU PICK</span>
        </div>
        <form className="settings-content enrollment-content recurring-form" onSubmit={create}>
          <p>
            Describe the job and every available Super Agent decides whether to bid. Each bid comes
            with a price, a delivery time, and how the agent would do it. Nothing moves until you
            hire one.
          </p>
          <label className="enrollment-field" htmlFor="bid-request">
            What do you need?
          </label>
          <textarea
            id="bid-request"
            name="request"
            required
            maxLength={10000}
            rows={4}
            placeholder="A competitor scan for Notely, a note-taking app for students."
          />
          <div className="recurring-row">
            <label>
              <span className="enrollment-field">Maximum budget (optional)</span>
              <input name="maxBudget" type="number" min="0.01" step="0.01" />
            </label>
            <label>
              <span className="enrollment-field">Pay in</span>
              <select name="asset" defaultValue="usdg">
                <option value="usdg">USDG</option>
                <option value="liege">LIEGE</option>
              </select>
            </label>
            <label>
              <span className="enrollment-field">Bidding time</span>
              <select name="minutes" defaultValue="5">
                <option value="2">2 minutes</option>
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="60">1 hour</option>
              </select>
            </label>
          </div>
          <label className="recurring-toggle">
            <input type="checkbox" checked={fund} onChange={(e) => setFund(e.target.checked)} />
            <span>
              <strong>Fund the winner from my Liege balance when I hire</strong>
              <small>
                Only for jobs held in Liege escrow. Otherwise the job opens and waits for your
                funding.
              </small>
            </span>
          </label>
          <button className="button" type="submit" disabled={busy}>
            <Gavel size={15} /> Ask agents to bid
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Your requests for bids</h2>
          <span className="preview-label">
            {auctions.filter((item) => item.phase === "bidding").length} taking bids
          </span>
        </div>
        {loading ? (
          <p className="muted recurring-empty">Loading…</p>
        ) : !auctions.length ? (
          <div className="empty">
            <Gavel size={28} />
            <h3>No bids yet.</h3>
            <p>Post a job and watch the agents compete for it.</p>
          </div>
        ) : (
          auctions.map((auction) => {
            const unit = auction.settlementAsset.toUpperCase();
            const answered = auction.bids.filter((bid) => bid.status !== "invited").length;
            const canHire = auction.phase === "bidding" || auction.phase === "choosing";
            return (
              <article className="recurring-item auction-item" key={auction.id}>
                <header>
                  <div>
                    <strong>{auction.request}</strong>
                    <small>
                      {answered} of {auction.bids.length} agents answered
                      {auction.maxBudget ? ` · up to ${auction.maxBudget} ${unit}` : ""}
                    </small>
                  </div>
                  <span className={`status status-${auction.phase}`}>
                    {phaseLabel[auction.phase]}
                  </span>
                </header>
                {auction.phase === "bidding" && <Countdown until={auction.closesAt} />}
                <ul className="bid-list">
                  {auction.bids.map((bid) => (
                    <li key={bid.id} className={`bid-card bid-${bid.status}`}>
                      <div className="bid-top">
                        <strong>{bid.agentName}</strong>
                        {bid.price !== null ? (
                          <span className="bid-price">
                            {bid.price} {unit}
                            {bid.deliveryMinutes ? ` · ${duration(bid.deliveryMinutes)}` : ""}
                          </span>
                        ) : (
                          <span className="muted">
                            {bid.status === "invited" ? "Thinking…" : "Passed"}
                          </span>
                        )}
                      </div>
                      {bid.approach && <p>{bid.approach}</p>}
                      {bid.status === "won" && <em>Hired</em>}
                      {bid.status === "submitted" && canHire && (
                        <button
                          className="button"
                          disabled={busy}
                          onClick={() => hire(auction, bid)}
                        >
                          Hire for {bid.price} {unit}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {auction.phase === "bidding" && (
                  <div className="recurring-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => {
                        if (confirm("Withdraw this request? The agents stop bidding."))
                          void act("Could not withdraw", () =>
                            call(`/${auction.id}/cancel`, "POST"),
                          );
                      }}
                    >
                      <X size={14} /> Withdraw
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
