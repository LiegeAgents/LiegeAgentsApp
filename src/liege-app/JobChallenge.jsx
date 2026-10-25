import React, { useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

const when = (value) => new Date(value).toLocaleString();

/**
 * The challenge window on a decided job. The payout waits until the window closes; the side the
 * decision went against may challenge it first, and a Liege arbitrator settles the dispute.
 */
export default function JobChallenge({ jobId, token, status }) {
  const decided = ["completed", "rejected", "challenged"].includes(String(status).toLowerCase());
  const [data, setData] = useState(null),
    [reason, setReason] = useState(""),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    api
      .jobChallenge(token, jobId)
      .then((result) => setData(result.data))
      .catch(() => setData(null));
  useEffect(() => {
    if (decided) void load();
  }, [jobId, status]);
  if (!decided || !data || (!data.payoutDueAt && !data.dispute)) return null;
  const { dispute } = data;
  const asset = String(data.asset).toUpperCase();
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api.challengeJob(token, jobId, reason.trim());
      setOpen(false);
      await load();
    } catch (e) {
      setError(e?.message || "The challenge could not be opened.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="job-challenge">
      <h3>
        <Scale size={15} /> Challenge window
      </h3>
      {dispute ? (
        dispute.status === "open" ? (
          <p className="muted">
            The {dispute.decidedOutcome === "accepted" ? "acceptance" : "rejection"} was challenged
            on {when(dispute.createdAt)} with a {dispute.bond} {asset} bond. A Liege arbitrator is
            reviewing it; the payout waits until then.
          </p>
        ) : (
          <p className="muted">
            The challenge was {dispute.resolution}:{" "}
            {dispute.resolution === "upheld"
              ? "the decision was reversed and the bond returned."
              : "the decision stands and the bond went to the other side."}{" "}
            {dispute.rationale && <q>{dispute.rationale}</q>}
          </p>
        )
      ) : data.windowOpen ? (
        <>
          <p className="muted">
            The decision pays out on {when(data.payoutDueAt)}. Until then, the side it went against
            can challenge it with a {data.bond} {asset} bond, returned if the challenge is upheld.
          </p>
          {open ? (
            <div className="challenge-form">
              <label htmlFor="challenge-reason">Why the decision is wrong</label>
              <textarea
                id="challenge-reason"
                rows={3}
                minLength={10}
                maxLength={4000}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              {error && <Notice error>{error}</Notice>}
              <div className="receipt-actions">
                <Button small onClick={submit} disabled={busy || reason.trim().length < 10}>
                  {busy ? "Opening…" : `Challenge · ${data.bond} ${asset} bond`}
                </Button>
                <Button small secondary onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="receipt-actions">
              <Button small secondary onClick={() => setOpen(true)}>
                Challenge this decision
              </Button>
            </div>
          )}
        </>
      ) : (
        <p className="muted">
          {data.payoutReleasedAt
            ? `The window closed without a challenge; paid out on ${when(data.payoutReleasedAt)}.`
            : "The window has closed; the payout is being released."}
        </p>
      )}
    </section>
  );
}
