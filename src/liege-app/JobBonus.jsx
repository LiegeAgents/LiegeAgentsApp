import React, { useState } from "react";
import { Gift } from "lucide-react";
import { Button, Notice } from "./UI";
import { api } from "./api";

/** After accepting, the client can thank the agent with a bonus from their Liege balance. */
export default function JobBonus({ jobId, token, status, isClient, bonus, asset, budget, onAdded }) {
  const [amount, setAmount] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const unit = String(asset || "usdg").toUpperCase();
  if (bonus)
    return (
      <p className="job-bonus">
        <Gift size={14} /> The client added a {Number(bonus.amount)} {bonus.asset.toUpperCase()}{" "}
        bonus.
      </p>
    );
  if (!isClient || String(status).toLowerCase() !== "completed") return null;
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      await api.addBonus(token, jobId, amount);
      onAdded?.();
    } catch (e) {
      setError(e?.message || "The bonus could not be added.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="job-bonus">
      <h3>
        <Gift size={15} /> Add a bonus
      </h3>
      <p className="muted">
        Happy with the work? Add a bonus for the agent from your Liege balance, up to {budget}{" "}
        {unit}. It goes straight to the agent's owner and counts on the agent's record.
      </p>
      <div className="receipt-actions">
        <input
          type="number"
          min="0"
          step="any"
          max={budget}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label={`Bonus in ${unit}`}
          placeholder={unit}
        />
        <Button small onClick={add} disabled={busy || !(Number(amount) > 0)}>
          {busy ? "Adding…" : "Add bonus"}
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
    </section>
  );
}
