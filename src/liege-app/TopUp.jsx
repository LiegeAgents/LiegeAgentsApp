import React, { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { Button, Field, Notice } from "./UI";
import { api } from "./api";
import { useWallet } from "./wallet/Wallet";

/**
 * Adds USDG or LIEGE to the workspace balance that pays for instant calls, jobs funded from the
 * balance, hiring keys, and challenge bonds. The transfer goes from the connected wallet to
 * Liege's top-up address on Robinhood Chain and is credited after it confirms.
 */
export default function TopUp({ token, onNotice }) {
  const wallet = useWallet();
  const [info, setInfo] = useState(null),
    [balances, setBalances] = useState(null),
    [asset, setAsset] = useState("usdg"),
    [amount, setAmount] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    Promise.all([api.topups(token), api.me(token)])
      .then(([topups, me]) => {
        setInfo(topups.data);
        setBalances(me.data?.balances ?? null);
      })
      .catch((e) => setError(e?.message || "Could not load top-ups."));
  useEffect(() => {
    void load();
  }, [token]);
  if (!info) return error ? <Notice error>{error}</Notice> : null;
  const tokens = Object.entries(info.tokens).filter(([, value]) => value);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const credited = await wallet.topUp({
        asset,
        amount,
        address: info.address,
        token: info.tokens[asset],
      });
      setAmount("");
      onNotice?.(`Added ${credited.amount} ${asset.toUpperCase()} to your balance.`);
      await load();
    } catch (e) {
      setError(e?.shortMessage || e?.message || "The top-up did not go through.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="settings-panel" onSubmit={submit}>
      <h2>
        <Wallet size={16} /> Balance and top-ups
      </h2>
      {balances && (
        <p className="mono">
          {balances.availableUsdg} USDG · {balances.availableLiege} LIEGE available
        </p>
      )}
      <p>
        Your balance pays for instant calls, jobs funded from your balance, hiring keys, and
        challenge bonds. Top up from your connected wallet on Robinhood Chain; it is credited after{" "}
        {info.confirmations} confirmations.
      </p>
      {!info.enabled ? (
        <Notice>Top-ups are not open yet.</Notice>
      ) : (
        <>
          <Field label="Token">
            <select value={asset} onChange={(e) => setAsset(e.target.value)}>
              {tokens.map(([key]) => (
                <option key={key} value={key}>
                  {key.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount">
            <input
              type="number"
              min="0"
              step="any"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <p className="mono muted">Sent to {info.address}</p>
          {error && <Notice error>{error}</Notice>}
          <Button type="submit" disabled={busy || !(Number(amount) > 0)}>
            {busy ? "Waiting for confirmation…" : `Top up ${asset.toUpperCase()}`}
          </Button>
        </>
      )}
      {info.topups.length > 0 && (
        <ul className="topup-history">
          {info.topups.map((item) => (
            <li key={item.tx_hash}>
              +{item.amount} {item.asset.toUpperCase()} ·{" "}
              {new Date(item.created_at).toLocaleDateString()}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
