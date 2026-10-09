import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  ExternalLink,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import "./style.css";

const API = import.meta.env.VITE_API_BASE_URL || "/api/v1";
const SHORT = { 30: "30 days", 45: "45 days", 90: "90 days" };
const format = (raw, digits = 5) => {
  const value = Number(BigInt(raw || "0")) / 1e18;
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
};
const date = (value) =>
  new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
const duration = (seconds) => {
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600),
    mins = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins}m` : `${mins}m`;
};

async function api(path, options = {}) {
  const response = await fetch(`${API}/staking${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const error = new Error(body.error?.message || body.message || "Could not complete request.");
    error.code = body.error?.code;
    throw error;
  }
  return body.data;
}

function App() {
  const [config, setConfig] = useState(null),
    [wallet, setWallet] = useState(""),
    [locks, setLocks] = useState([]),
    [payouts, setPayouts] = useState([]);
  const [selectedTerm, setSelectedTerm] = useState(30),
    [amount, setAmount] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const tiers = config?.terms || [];
  const selected = tiers.find((tier) => tier.days === Number(selectedTerm));
  const reserveSurplus = BigInt(config?.poolSurplus || "0");
  const estimated = useMemo(() => {
    if (!selected || !/^\d+(\.\d{1,18})?$/.test(amount) || Number(amount) <= 0) return null;
    const [whole, fraction = ""] = amount.split(".");
    const raw = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
    const reward = (raw * BigInt(selected.apyBps) * BigInt(selected.days)) / 3650000n;
    return {
      principal: raw.toString(),
      reward: reward.toString(),
      total: (raw + reward).toString(),
    };
  }, [amount, selected]);

  const refresh = useCallback(
    async (address = wallet) => {
      const current = await api("/config");
      setConfig(current);
      if (address) {
        const [positionData, payoutData] = await Promise.all([
          api(`/locks/${address}`),
          api(`/payouts/${address}`),
        ]);
        setLocks(positionData.locks);
        setPayouts(payoutData.payouts);
      }
    },
    [wallet],
  );
  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, []);
  useEffect(() => {
    if (!wallet) return;
    const timer = setInterval(() => refresh(wallet).catch(() => {}), 30_000);
    return () => clearInterval(timer);
  }, [wallet, refresh]);

  async function connect() {
    try {
      if (!window.ethereum) throw new Error("Install or open an EVM wallet to continue.");
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const address = accounts[0];
      if (!address) throw new Error("No wallet account was returned.");
      const chainHex = await window.ethereum.request({ method: "eth_chainId" });
      if (parseInt(chainHex, 16) !== config.chainId) {
        const chainId = `0x${config.chainId.toString(16)}`;
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId }],
          });
        } catch (error) {
          if (error.code !== 4902) throw error;
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId,
                chainName: "Robinhood Chain",
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
                rpcUrls: ["https://rpc.mainnet.chain.robinhood.com/"],
                blockExplorerUrls: ["https://robinhoodchain.blockscout.com/"],
              },
            ],
          });
        }
      }
      setWallet(address);
      await refresh(address);
      setMessage("");
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function stake() {
    setBusy(true);
    setMessage("");
    try {
      if (!wallet || !estimated || !config?.poolAddress)
        throw new Error("Connect a wallet and enter a valid amount first.");
      const prepared = await api("/prepare", {
        method: "POST",
        body: JSON.stringify({ amount: estimated.principal, termDays: Number(selectedTerm) }),
      });
      const tx = await window.ethereum.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet, ...prepared.transaction }],
      });
      setMessage("Transfer submitted. Waiting for confirmation…");
      let credited;
      for (let attempt = 0; attempt < 60; attempt++) {
        try {
          credited = await api("/locks", {
            method: "POST",
            body: JSON.stringify({
              walletAddress: wallet,
              txHash: tx,
              amount: estimated.principal,
              termDays: Number(selectedTerm),
            }),
          });
          break;
        } catch (error) {
          if (!["awaiting_confirmations", "awaiting_receipt"].includes(error.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
      if (!credited)
        throw new Error(
          "Still waiting for confirmation. Refresh later to reconcile this transfer using its transaction hash.",
        );
      setMessage(
        `LIEGE locked for ${selectedTerm} days. Position ${credited.lock.id.slice(0, 8)}…`,
      );
      setAmount("");
      await refresh(wallet);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function claim(lock) {
    setBusy(true);
    setMessage("");
    try {
      const { message: claimMessage } = await api(`/locks/${lock.id}/claim-message`, {
        method: "POST",
        body: JSON.stringify({ walletAddress: wallet }),
      });
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [claimMessage, wallet],
      });
      const result = await api(`/locks/${lock.id}/claim`, {
        method: "POST",
        body: JSON.stringify({ walletAddress: wallet, signature }),
      });
      setMessage(
        "Claim requested. The pool will send your principal and LIEGE reward after the payout confirms.",
      );
      await refresh(wallet);
      void result;
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyPool() {
    if (!config?.poolAddress) return;
    await navigator.clipboard.writeText(config.poolAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  if (!config)
    return (
      <main className="loading">
        <div className="spinner" />
        <p>Loading staking pool…</p>
        {message && <p className="notice error">{message}</p>}
      </main>
    );
  const poolReady = config.enabled;
  const currentPayout = (lockId) => payouts.find((payout) => payout.lock_id === lockId);

  return (
    <div className="shell">
      <header>
        <a className="brand" href="https://www.liegeagents.com">
          <img src="https://www.liegeagents.com/brand/logo-transparent.png" />
          <span>staking</span>
        </a>
        <div className="header-right">
          <span className="network">
            <i /> Robinhood Chain
          </span>
          {wallet ? (
            <button className="wallet connected" onClick={() => setWallet("")}>
              <Wallet size={16} />
              {wallet.slice(0, 6)}…{wallet.slice(-4)}
              <ChevronDown size={14} />
            </button>
          ) : (
            <button className="wallet" onClick={connect}>
              <Wallet size={16} /> Connect wallet
            </button>
          )}
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="eyebrow">
            <span /> LIEGE TOKEN STAKING
          </div>
          <h1>
            Lock with purpose.
            <br />
            <em>Earn in LIEGE.</em>
          </h1>
          <p>
            Choose a fixed term, deposit LIEGE into the pool, and claim your principal plus the
            stated reward when your lock matures.
          </p>
          <div className="hero-stats">
            <div>
              <span>Stake asset</span>
              <strong>$LIEGE only</strong>
            </div>
            <div>
              <span>Lock terms</span>
              <strong>30 · 45 · 90 days</strong>
            </div>
            <div>
              <span>Early withdrawal</span>
              <strong>Not available</strong>
            </div>
          </div>
        </section>
        {!poolReady && (
          <div className="notice warning">
            <ShieldCheck size={18} /> Pool setup is not complete yet. Deposits stay disabled until
            the pool wallet and its payout signer are configured and funded.
          </div>
        )}
        {message && (
          <div className="notice">
            <span>{message}</span>
            <button aria-label="Dismiss" onClick={() => setMessage("")}>
              ×
            </button>
          </div>
        )}
        <section className="content-grid">
          <div className="panel stake-panel">
            <div className="panel-heading">
              <div>
                <div className="eyebrow">START A POSITION</div>
                <h2>Choose your lock</h2>
              </div>
              <LockKeyhole size={21} />
            </div>
            <div className="term-grid">
              {tiers.map((tier) => (
                <button
                  key={tier.days}
                  className={`term ${Number(selectedTerm) === tier.days ? "selected" : ""}`}
                  onClick={() => setSelectedTerm(tier.days)}
                >
                  <span>{tier.label}</span>
                  <strong>{tier.apyPercent}</strong>
                  <small>APY</small>
                </button>
              ))}
            </div>
            <label className="field-label" htmlFor="stake-amount">
              Amount to stake
            </label>
            <div className="amount-wrap">
              <input
                id="stake-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              <span>
                <img src="https://www.liegeagents.com/brand/logo.png" /> LIEGE
              </span>
            </div>
            {estimated && (
              <div className="estimate">
                <div>
                  <span>Principal locked</span>
                  <strong>{format(estimated.principal)} LIEGE</strong>
                </div>
                <div>
                  <span>Projected reward</span>
                  <strong className="green">+{format(estimated.reward)} LIEGE</strong>
                </div>
                <div className="estimate-total">
                  <span>At maturity</span>
                  <strong>{format(estimated.total)} LIEGE</strong>
                </div>
              </div>
            )}
            <button
              className="primary"
              disabled={!wallet || !poolReady || !estimated || busy}
              onClick={stake}
            >
              {busy ? (
                <>
                  <RefreshCw className="spin" size={17} /> Processing…
                </>
              ) : (
                <>
                  Stake LIEGE <ArrowUpRight size={17} />
                </>
              )}
            </button>
            <p className="fineprint">
              Your wallet sends the exact LIEGE amount to the pool. Review the network and transfer
              details in your wallet before confirming.
            </p>
          </div>
          <aside className="panel pool-panel">
            <div className="eyebrow">POOL STATUS</div>
            <h2>Your pool, on-chain.</h2>
            <p>
              The pool needs enough LIEGE to cover all locked principal and promised rewards. ETH is
              used for pool payout gas.
            </p>
            <div className="pool-balance">
              <span>Current LIEGE pool balance</span>
              <strong>
                {format(config.poolBalance)} <small>LIEGE</small>
              </strong>
            </div>
            <div className="pool-meta">
              <span>Locked principal + rewards</span>
              <strong>{format(config.poolLiabilities)} LIEGE</strong>
            </div>
            <div className="pool-meta">
              <span>Uncommitted reserve</span>
              <strong className={reserveSurplus < 0n ? "deficit" : "reserve-positive"}>
                {reserveSurplus < 0n ? "−" : ""}
                {format((reserveSurplus < 0n ? -reserveSurplus : reserveSurplus).toString())} LIEGE
              </strong>
            </div>
            <div className="pool-meta">
              <span>Pool gas balance</span>
              <strong>{format(config.poolEthBalance)} ETH</strong>
            </div>
            <div className="pool-meta">
              <span>Pool wallet</span>
              <button onClick={copyPool} disabled={!config.poolAddress}>
                {config.poolAddress
                  ? `${config.poolAddress.slice(0, 8)}…${config.poolAddress.slice(-6)}`
                  : "Not configured"}
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            {config.poolAddress && (
              <a
                className="explorer"
                href={`https://robinhoodchain.blockscout.com/address/${config.poolAddress}`}
                target="_blank"
                rel="noreferrer"
              >
                View pool address <ExternalLink size={14} />
              </a>
            )}
            <div className="risk-note">
              <ShieldCheck size={16} />
              <span>
                Fixed-term locks cannot be withdrawn early. Rewards are subject to pool reserves and
                successful transaction settlement.
              </span>
            </div>
          </aside>
        </section>
        <section className="positions">
          <div className="section-heading">
            <div>
              <div className="eyebrow">YOUR POSITIONS</div>
              <h2>Staking activity</h2>
            </div>
            {wallet && (
              <button className="refresh" onClick={() => refresh(wallet)}>
                <RefreshCw size={15} /> Refresh
              </button>
            )}
          </div>
          {!wallet ? (
            <div className="empty">
              <Wallet />
              <p>Connect your wallet to see your staking positions.</p>
            </div>
          ) : locks.length === 0 ? (
            <div className="empty">
              <ArrowDownLeft />
              <p>No positions yet. Your confirmed LIEGE stakes will appear here.</p>
            </div>
          ) : (
            <div className="lock-list">
              {locks.map((lock) => {
                const payout = currentPayout(lock.id);
                const ready = lock.effectiveStatus === "matured";
                return (
                  <article className="lock-row" key={lock.id}>
                    <div className="lock-icon">
                      <LockKeyhole size={18} />
                    </div>
                    <div className="lock-details">
                      <strong>
                        {format(lock.principal_amount)} LIEGE{" "}
                        <span className={`status ${lock.effectiveStatus}`}>
                          {lock.effectiveStatus}
                        </span>
                      </strong>
                      <span>
                        {SHORT[lock.term_days]} · {Number(lock.apy_bps) / 100}% APY · started{" "}
                        {date(lock.starts_at)}
                      </span>
                    </div>
                    <div className="lock-maturity">
                      <span>{ready ? "Matured" : "Unlocks"}</span>
                      <strong>
                        {ready
                          ? "Ready to claim"
                          : `${date(lock.unlocks_at)} · ${duration(lock.secondsRemaining)}`}
                      </strong>
                    </div>
                    <div className="lock-return">
                      <span>Projected return</span>
                      <strong>
                        {format(
                          (BigInt(lock.principal_amount) + BigInt(lock.reward_amount)).toString(),
                        )}{" "}
                        LIEGE
                      </strong>
                    </div>
                    {lock.status === "claimed" && payout?.status === "failed" ? (
                      <button
                        className="claim"
                        disabled={busy || !config.payoutEnabled}
                        onClick={() => claim(lock)}
                      >
                        Retry payout
                      </button>
                    ) : lock.status === "claimed" ? (
                      <span className={`payout ${payout?.status || "requested"}`}>
                        {payout?.status === "confirmed"
                          ? "Paid"
                          : `Payout ${payout?.status || "pending"}`}
                      </span>
                    ) : (
                      <button
                        className="claim"
                        disabled={!ready || busy || !config.payoutEnabled}
                        title={
                          !config.payoutEnabled ? "Pool payout signer is not configured" : undefined
                        }
                        onClick={() => claim(lock)}
                      >
                        {ready ? (
                          "Claim"
                        ) : (
                          <>
                            <Clock3 size={14} /> Locked
                          </>
                        )}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
        <section className="disclosure">
          <h3>Understand the terms</h3>
          <p>
            Rewards use a fixed calculation based on the selected APY and lock duration. Positions
            start when your deposit is confirmed on-chain. A position is non-withdrawable until its
            maturity time. Claiming requires a wallet signature and a pool payout transaction. Never
            stake more than you can afford to lock for the full term.
          </p>
        </section>
      </main>
      <footer>
        <span>Liege Staking · Independent token pool</span>
        <a href="https://www.liegeagents.com">
          Liege Agents <ExternalLink size={13} />
        </a>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
