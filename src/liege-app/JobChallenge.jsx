import React, { useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

const when = (value) => new Date(value).toLocaleString();

/**
 * The challenge window on a decided job. The payout waits until the window closes; the side the
 * decision went against may challenge it first, and a Liege arbitrator settles the dispute. A
 * panel's decision can itself be appealed to an arbitrator before its appeal window closes.
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
      if (dispute) await api.appealJob(token, jobId, reason.trim());
      else await api.challengeJob(token, jobId, reason.trim());
      setOpen(false);
      setReason("");
      await load();
    } catch (e) {
      setError(e?.message || `The ${dispute ? "appeal" : "challenge"} could not be opened.`);
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
        dispute.status === "open" && dispute.panelResolution ? (
          <>
            <p className="muted">
              The panel {dispute.panelResolution} the challenge
              {dispute.panelResolution === "upheld"
                ? ", reversing the decision."
                : ", so the decision stands."}{" "}
              {dispute.appeal
                ? `It was appealed on ${when(dispute.appeal.appealedAt)} with a ${dispute.appeal.bond} ${asset} bond; a Liege arbitrator makes the final decision, and the payout waits until then.`
                : `The job settles on it on ${when(dispute.appealDeadlineAt)} unless the side it went against appeals to a Liege arbitrator with a ${dispute.appealBond} ${asset} bond, returned if the panel is overturned.`}
            </p>
            {data.canAppeal && (
              <ReasonForm
                open={open}
                setOpen={setOpen}
                reason={reason}
                setReason={setReason}
                error={error}
                busy={busy}
                submit={submit}
                label="Why the panel got it wrong"
                action={`Appeal · ${dispute.appealBond} ${asset} bond`}
                start="Appeal to an arbitrator"
              />
            )}
          </>
        ) : dispute.status === "open" ? (
          <p className="muted">
            The {dispute.decidedOutcome === "accepted" ? "acceptance" : "rejection"} was challenged
            on {when(dispute.createdAt)} with a {dispute.bond} {asset} bond.{" "}
            {dispute.decidedBy === "panel"
              ? `A panel of independent staked evaluators is deciding it by majority, by ${when(dispute.panelDeadlineAt)}.`
              : "A Liege arbitrator is reviewing it."}{" "}
            The payout waits until then.
          </p>
        ) : (
          <p className="muted">
            The challenge was {dispute.resolution}:{" "}
            {dispute.resolution === "upheld"
              ? `the decision was reversed and the bond returned.${dispute.slashedAmount ? ` The evaluator lost ${dispute.slashedAmount} ${asset} of stake, paid to the challenger, and forfeited their fee.` : ""}`
              : "the decision stands and the bond went to the other side."}{" "}
            {dispute.appeal?.outcome &&
              `On appeal, a Liege arbitrator ${dispute.appeal.outcome} the panel, and the appeal bond ${dispute.appeal.outcome === "overturned" ? "was returned" : "went to the other side"}. `}
            {dispute.rationale && <q>{dispute.rationale}</q>}
          </p>
        )
      ) : data.windowOpen ? (
        <>
          <p className="muted">
            The decision pays out on {when(data.payoutDueAt)}. Until then, the side it went against
            can challenge it with a {data.bond} {asset} bond, returned if the challenge is upheld.
          </p>
          <ReasonForm
            open={open}
            setOpen={setOpen}
            reason={reason}
            setReason={setReason}
            error={error}
            busy={busy}
            submit={submit}
            label="Why the decision is wrong"
            action={`Challenge · ${data.bond} ${asset} bond`}
            start="Challenge this decision"
          />
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

function ReasonForm({
  open,
  setOpen,
  reason,
  setReason,
  error,
  busy,
  submit,
  label,
  action,
  start,
}) {
  if (!open)
    return (
      <div className="receipt-actions">
        <Button small secondary onClick={() => setOpen(true)}>
          {start}
        </Button>
      </div>
    );
  return (
    <div className="challenge-form">
      <label htmlFor="challenge-reason">{label}</label>
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
          {busy ? "Opening…" : action}
        </Button>
        <Button small secondary onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
