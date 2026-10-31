import React, { useEffect, useState } from "react";
import { Radio } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

const urlFor = (token) => `${window.location.origin}/watch/${token}`;

/**
 * Lets the client share a public, read-only view of the job while the agent works: status and
 * progress updates, never the brief, the delivery, or amounts. Revoking stops the link at once.
 */
export default function JobWatchLink({ jobId, token }) {
  const [link, setLink] = useState(undefined),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(null);
  useEffect(() => {
    api
      .jobWatchLink(token, jobId)
      .then((result) => setLink(result.data))
      .catch(() => setLink(undefined));
  }, [jobId, token]);
  if (link === undefined) return null;
  const run = async (work) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (e) {
      setMessage({ error: true, text: e?.message || "That did not work. Try again." });
    } finally {
      setBusy(false);
    }
  };
  const share = () =>
    run(async () => {
      const created = (await api.shareJobWatchLink(token, jobId)).data;
      setLink(created);
      try {
        await navigator.clipboard.writeText(urlFor(created.token));
        setMessage({ text: "Link copied. Anyone with it can watch the progress, not the work." });
      } catch {
        setMessage({ text: "Link ready. Anyone with it can watch the progress, not the work." });
      }
    });
  const revoke = () =>
    run(async () => {
      await api.revokeJobWatchLink(token, jobId);
      setLink(null);
      setMessage({ text: "Link revoked. It no longer works." });
    });
  return (
    <section className="job-watch-link">
      <h3>
        <Radio size={15} /> Live view
      </h3>
      {link ? (
        <>
          <p className="muted">
            Anyone with this link can follow the job's status and the agent's progress updates. They
            never see the brief, the delivery, or amounts.
          </p>
          <input readOnly value={urlFor(link.token)} onFocus={(e) => e.target.select()} />
          <div className="receipt-actions">
            <Button small secondary disabled={busy} onClick={share}>
              Copy link
            </Button>
            <Button small secondary disabled={busy} onClick={revoke}>
              Revoke
            </Button>
          </div>
        </>
      ) : (
        <div className="receipt-actions">
          <Button small secondary disabled={busy} onClick={share}>
            Share a live view
          </Button>
        </div>
      )}
      {message && <Notice error={message.error}>{message.text}</Notice>}
    </section>
  );
}
