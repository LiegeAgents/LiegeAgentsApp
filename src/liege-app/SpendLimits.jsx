import React, { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { Button, Field, Notice } from "./UI";
import { api } from "./api";

const LABEL = { usdg: "USDG", liege: "LIEGE" };
const asInput = (value) => (value == null ? "" : value);
const asLimit = (value) => (value === "" ? null : Number(value));

/**
 * Spend limits on the Liege balance. Funding jobs, instant calls (including Telegram), bonuses,
 * and invoices all count, net of refunds. A tighter limit applies at once; a looser one waits a
 * day, so someone who gets into the workspace cannot lift it and spend the balance.
 */
export default function SpendLimits({ token }) {
  const [limits, setLimits] = useState([]),
    [drafts, setDrafts] = useState({}),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(null);
  const show = (rows) => {
    setLimits(rows);
    setDrafts(
      Object.fromEntries(
        rows.map((row) => [
          row.asset,
          { daily: asInput(row.daily), monthly: asInput(row.monthly) },
        ]),
      ),
    );
  };
  useEffect(() => {
    api
      .spendLimits(token)
      .then((result) => show(result.data))
      .catch(() => setLimits([]));
  }, [token]);
  const save = async (asset) => {
    setBusy(true);
    setMessage(null);
    try {
      const draft = drafts[asset];
      const result = await api.setSpendLimits(
        token,
        asset,
        asLimit(draft.daily),
        asLimit(draft.monthly),
      );
      const saved = (await api.spendLimits(token)).data;
      show(saved);
      setMessage({
        text: result.data.scheduled
          ? `Saved. The looser ${LABEL[asset]} limit takes effect ${new Date(result.data.scheduled.at).toLocaleString()}.`
          : `${LABEL[asset]} limits saved.`,
      });
    } catch (e) {
      setMessage({ error: true, text: e?.message || "That did not work. Try again." });
    } finally {
      setBusy(false);
    }
  };
  if (!limits.length) return null;
  return (
    <div className="settings-panel spend-limits">
      <h2>
        <Gauge size={16} /> Spend limits
      </h2>
      <p>
        Cap what your Liege balance can spend on jobs, instant calls, bonuses, and invoices. Leave a
        field empty for no limit. Lowering a limit applies now; raising or removing one takes 24
        hours.
      </p>
      {limits.map((row) => (
        <div key={row.asset} className="spend-limit-row">
          <h3>{LABEL[row.asset]}</h3>
          <p className="muted">
            Spent {row.spent.day} in the last 24 hours, {row.spent.month} in the last 30 days.
          </p>
          <div className="spend-limit-fields">
            {[
              ["daily", "Any 24 hours"],
              ["monthly", "Any 30 days"],
            ].map(([key, label]) => (
              <Field key={key} label={`${label} (${LABEL[row.asset]})`}>
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="No limit"
                  value={drafts[row.asset]?.[key] ?? ""}
                  onChange={(e) =>
                    setDrafts((current) => ({
                      ...current,
                      [row.asset]: { ...current[row.asset], [key]: e.target.value },
                    }))
                  }
                />
              </Field>
            ))}
          </div>
          {row.scheduled && (
            <p className="muted">
              Changing to {row.scheduled.daily ?? "no limit"} a day and{" "}
              {row.scheduled.monthly ?? "no limit"} a month on{" "}
              {new Date(row.scheduled.at).toLocaleString()}.
            </p>
          )}
          <div className="receipt-actions">
            <Button small disabled={busy} onClick={() => save(row.asset)}>
              Save {LABEL[row.asset]} limits
            </Button>
          </div>
        </div>
      ))}
      {message && <Notice error={message.error}>{message.text}</Notice>}
    </div>
  );
}
