import React, { useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

const when = (value) => new Date(value).toLocaleString();

/**
 * Disputes this evaluator was drawn to decide. Each panelist reads the case and votes once; the
 * majority settles the job. Other panelists' votes stay hidden until the dispute is resolved.
 */
export default function DisputePanels({ token }) {
  const [items, setItems] = useState([]),
    [open, setOpen] = useState(null),
    [rationale, setRationale] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    api
      .panelDisputes(token)
      .then((result) => setItems(result.data || []))
      .catch(() => setItems([]));
  useEffect(() => {
    if (token) void load();
  }, [token]);
  if (!items.length) return null;
  const show = async (id) => {
    setError("");
    setRationale("");
    try {
      setOpen((await api.panelDispute(token, id)).data);
    } catch (e) {
      setError(e?.message || "The dispute could not be loaded.");
    }
  };
  const cast = async (decision) => {
    setBusy(true);
    setError("");
    try {
      await api.votePanelDispute(token, open.id, decision, rationale.trim());
      await show(open.id);
      await load();
    } catch (e) {
      setError(e?.message || "The vote was not recorded.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-panel dispute-panels">
      <h2>
        <Scale size={16} /> Dispute panels
      </h2>
      <p className="muted">
        You were drawn at random to decide these challenged decisions. Vote once; the majority
        settles the job, and each vote counts toward your accuracy.
      </p>
      <ul className="dispute-list">
        {items.map((item) => (
          <li key={item.id}>
            <button className="link-button" onClick={() => show(item.id)}>
              {item.jobTitle}
            </button>
            <small>
              {item.status !== "open"
                ? `Resolved: ${item.resolution}`
                : item.myVote
                  ? `You voted ${item.myVote}`
                  : `Vote by ${when(item.panelDeadlineAt)}`}
            </small>
          </li>
        ))}
      </ul>
      {open && (
        <article className="dispute-case">
          <h3>{open.jobTitle}</h3>
          <p>
            The evaluator <strong>{open.decidedOutcome}</strong> this delivery of {open.budget}{" "}
            {String(open.asset).toUpperCase()}. The challenge:
          </p>
          <blockquote>{open.reason}</blockquote>
          <h4>Brief</h4>
          <p className="job-brief">{open.brief}</p>
          <h4>Acceptance criteria</h4>
          <ul>
            {(open.acceptanceCriteria || []).map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <h4>Delivery</h4>
          <pre className="dispute-deliverable">{open.deliverable || "No delivery recorded."}</pre>
          {open.tally && (
            <p className="muted">
              Panel result: {open.tally.upheld} upheld, {open.tally.denied} denied of{" "}
              {open.tally.of}.
            </p>
          )}
          {open.status === "open" && !open.myVote && (
            <>
              <label htmlFor="panel-rationale">Your reasoning</label>
              <textarea
                id="panel-rationale"
                rows={3}
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
              />
              <div className="receipt-actions">
                <Button
                  small
                  disabled={busy || rationale.trim().length < 10}
                  onClick={() => cast("upheld")}
                >
                  Uphold the challenge
                </Button>
                <Button
                  small
                  secondary
                  disabled={busy || rationale.trim().length < 10}
                  onClick={() => cast("denied")}
                >
                  Deny the challenge
                </Button>
              </div>
            </>
          )}
          {open.myVote && open.status === "open" && (
            <p className="muted">You voted {open.myVote}. Waiting for the rest of the panel.</p>
          )}
        </article>
      )}
      {error && <Notice error>{error}</Notice>}
    </div>
  );
}
