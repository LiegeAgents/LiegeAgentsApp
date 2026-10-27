import React, { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { Button, Field, Notice } from "./UI";
import { api } from "./api";

/**
 * Links a Telegram account to this workspace. The linked chat can run rug checks from the Liege
 * balance, up to the daily cap set here, and prepare proposals that still wait for approval.
 */
export default function TelegramLink({ token }) {
  const [status, setStatus] = useState(null),
    [link, setLink] = useState(null),
    [cap, setCap] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    api
      .telegram(token)
      .then((result) => {
        setStatus(result.data);
        setCap(result.data.link?.daily_cap_usdg ?? "");
      })
      .catch(() => setStatus(null));
  useEffect(() => {
    void load();
  }, [token]);
  if (!status?.enabled) return null;
  const act = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
    } catch (e) {
      setError(e?.message || "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-panel">
      <h2>
        <Send size={16} /> Telegram
      </h2>
      {status.link ? (
        <>
          <p>
            Linked to Telegram{status.link.username ? ` as @${status.link.username}` : ""}. In a chat
            with @{status.botUsername}, use /rugcheck, /hire, and /balance.
          </p>
          <Field
            label="Daily limit for Telegram calls (USDG)"
            help="The most rug checks and other instant calls from Telegram may spend in 24 hours."
          >
            <input
              type="number"
              min="0"
              max="100"
              step="any"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          </Field>
          <div className="receipt-actions">
            <Button
              small
              disabled={busy}
              onClick={() => act(() => api.setTelegramCap(token, Number(cap)))}
            >
              Save limit
            </Button>
            <Button small secondary disabled={busy} onClick={() => act(() => api.unlinkTelegram(token))}>
              Disconnect
            </Button>
          </div>
        </>
      ) : (
        <>
          <p>
            Run rug checks and hire agents from Telegram. Rug checks are paid from your Liege
            balance, up to a daily limit (5 USDG to start); hires still wait for your approval here.
          </p>
          {link ? (
            <p>
              <a href={link} target="_blank" rel="noreferrer">
                Open @{status.botUsername} to finish linking
              </a>{" "}
              <span className="muted">(valid for 10 minutes, then refresh this page)</span>
            </p>
          ) : (
            <Button
              small
              disabled={busy}
              onClick={() =>
                act(async () => setLink((await api.startTelegramLink(token)).data.url))
              }
            >
              Link Telegram
            </Button>
          )}
        </>
      )}
      {error && <Notice error>{error}</Notice>}
    </div>
  );
}
