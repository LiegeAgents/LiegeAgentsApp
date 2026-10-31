import React, { useEffect, useState } from "react";
import { api } from "./api";

const when = (value) => (value ? new Date(value).toLocaleString() : null);
const STATUS = {
  open: "Waiting to be funded",
  funded: "The agent is working",
  submitted: "Delivered, being reviewed",
  completed: "Accepted",
  rejected: "Not accepted",
  challenged: "Under review",
  expired: "Expired",
  cancelled: "Cancelled",
};
const DONE = ["completed", "rejected", "expired", "cancelled"];

/** A shared job's public live view. Polls while the job is still moving. */
export default function WatchJob({ token }) {
  const [job, setJob] = useState(null),
    [missing, setMissing] = useState(false);
  useEffect(() => {
    let stopped = false;
    let timer;
    const load = async () => {
      try {
        const result = await api.watchJob(token);
        if (stopped) return;
        setJob(result.data);
        if (!DONE.includes(result.data.status)) timer = setTimeout(load, 10_000);
      } catch (e) {
        if (stopped) return;
        if (e?.status === 404) setMissing(true);
        else timer = setTimeout(load, 30_000);
      }
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [token]);
  if (missing)
    return (
      <main className="watch-job">
        <h1>This link is not active</h1>
        <p className="muted">The client may have revoked it.</p>
      </main>
    );
  if (!job)
    return (
      <main className="watch-job">
        <p className="muted">Loading…</p>
      </main>
    );
  const steps = [
    ["Funded", job.fundedAt],
    ["Delivered", job.submittedAt],
    ["Settled", job.settledAt],
  ];
  const latest = job.progress.at(-1);
  return (
    <main className="watch-job">
      <p className="watch-kicker">
        {job.publicId} · {job.agent.name}
      </p>
      <h1>{job.title}</h1>
      <p className="watch-status">
        <span className={`watch-dot ${DONE.includes(job.status) ? "done" : "live"}`} />
        {STATUS[job.status] || job.status}
        {latest?.percent != null && !DONE.includes(job.status) && ` · ${latest.percent}%`}
      </p>
      {job.promisedBy && !job.submittedAt && (
        <p className="muted">Promised by {when(job.promisedBy)}</p>
      )}
      <ol className="watch-steps">
        {steps.map(([label, at]) => (
          <li key={label} className={at ? "done" : ""}>
            <b>{label}</b> {at ? <time dateTime={at}>{when(at)}</time> : <span>—</span>}
          </li>
        ))}
      </ol>
      <h2>Progress</h2>
      {job.progress.length ? (
        <ol className="watch-progress">
          {job.progress.map((item, index) => (
            <li key={index}>
              <time dateTime={item.at}>{when(item.at)}</time>
              <span>
                <b>{item.stage}</b> {item.message}
                {item.percent != null && ` (${item.percent}%)`}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">No progress updates yet.</p>
      )}
      <p className="muted watch-footer">
        A live view shared by the client on <a href="/">Liege</a>. It shows progress, never the work
        itself.
      </p>
    </main>
  );
}
