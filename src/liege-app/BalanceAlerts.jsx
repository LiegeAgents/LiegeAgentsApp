import React, { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { Button, Field, Notice } from "./UI";
import { api } from "./api";

const ASSETS = [
  ["usdg", "USDG"],
  ["liege", "LIEGE"],
];

/**
 * Low-balance alerts. When a call, hire, or bond takes the available balance below a level set
 * here, the workspace gets a notification, and the linked Telegram chat a message.
 */
export default function BalanceAlerts({ token }) {
  const [levels, setLevels] = useState({ usdg: "", liege: "" }),
    [saved, setSaved] = useState({}),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(null);
  const load = () =>
    api
      .balanceAlerts(token)
      .then((result) => {
        const current = Object.fromEntries(result.data.map((alert) => [alert.asset, alert]));
        setSaved(current);
        setLevels({ usdg: current.usdg?.threshold ?? "", liege: current.liege?.threshold ?? "" });
      })
      .catch(() => setSaved({}));
  useEffect(() => {
    void load();
  }, [token]);
  const act = async (work) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await work());
      await load();
    } catch (e) {
      setMessage({ error: true, text: e?.message || "That did not work. Try again." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="settings-panel balance-alerts">
      <h2>
        <BellRing size={16} /> Low-balance alerts
      </h2>
      <p>
        Get a notification here, and on Telegram if it is linked, when instant calls, hires, or
        bonds take your available balance below a level you choose.
      </p>
      {ASSETS.map(([asset, label]) => (
        <div key={asset} className="balance-alert-row">
          <Field label={`Alert below (${label})`}>
            <input
              type="number"
              min="0"
              step="any"
              placeholder="Off"
              value={levels[asset]}
              onChange={(e) => setLevels((current) => ({ ...current, [asset]: e.target.value }))}
            />
          </Field>
          <div className="receipt-actions">
            <Button
              small
              disabled={busy || !(Number(levels[asset]) > 0)}
              onClick={() =>
                act(async () => {
                  const result = await api.setBalanceAlert(token, asset, Number(levels[asset]));
                  return {
                    text: result.data.below
                      ? `Saved. Your ${label} balance is already below ${result.data.threshold}; the alert fires on the next drop after a top-up.`
                      : `You'll be alerted when your ${label} balance falls below ${result.data.threshold}.`,
                  };
                })
              }
            >
              Save
            </Button>
            {saved[asset] && (
              <Button
                small
                secondary
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await api.removeBalanceAlert(token, asset);
                    return { text: `${label} alert turned off.` };
                  })
                }
              >
                Turn off
              </Button>
            )}
          </div>
          {saved[asset]?.triggered_at && (
            <p className="muted">
              Last alert {new Date(saved[asset].triggered_at).toLocaleString()}.
            </p>
          )}
        </div>
      ))}
      {message && <Notice error={message.error}>{message.text}</Notice>}
    </div>
  );
}
