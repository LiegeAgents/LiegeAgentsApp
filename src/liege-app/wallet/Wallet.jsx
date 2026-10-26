import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ConnectButton, RainbowKitProvider, getDefaultConfig } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  WagmiProvider,
  useAccount,
  useChainId,
  useDisconnect,
  useSignMessage,
  useSignTypedData,
  useSendTransaction,
  useWriteContract,
} from "wagmi";
import {
  createPublicClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  stringToHex,
} from "viem";
import { Wallet, LoaderCircle } from "lucide-react";
import { api, createWalletSession } from "../api";
import "./wallet.css";

const robinhoodChain = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Robinhood Chain Explorer", url: "https://robinhoodchain.blockscout.com" },
  },
};
const rpcClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(robinhoodChain.rpcUrls.default.http[0]),
});
const veiloraFactoryAbi = parseAbi([
  "function predictEscrow((uint32 factoryVersion,bytes32 jobId,address asset,uint256 budget,uint256 evaluatorFee,address client,address provider,address evaluator,address liegeSigner,uint16 legionCapBps,uint64 acceptBy,uint64 submitBy,uint64 evaluateWithin,uint64 expiresAt,bytes32 briefCommit,address[] legionRecipients) terms) view returns (address)",
  "function isEscrow(address escrow) view returns (bool)",
  "function create((uint32 factoryVersion,bytes32 jobId,address asset,uint256 budget,uint256 evaluatorFee,address client,address provider,address evaluator,address liegeSigner,uint16 legionCapBps,uint64 acceptBy,uint64 submitBy,uint64 evaluateWithin,uint64 expiresAt,bytes32 briefCommit,address[] legionRecipients) terms) returns (address)",
]);
const veiloraEscrowAbi = parseAbi([
  "function termsHash() view returns (bytes32)",
  "function providerNonce() view returns (uint256)",
  "function accepted() view returns (bool)",
  "function submittedAt() view returns (uint64)",
  "function accept(bytes signature,uint64 deadline)",
  "function markSubmitted(bytes32 deliverableCommit,bytes signature,uint64 deadline)",
]);
const walletConfig = getDefaultConfig({
  appName: "Liege",
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "walletconnect-project-id-required",
  chains: [robinhoodChain],
  ssr: false,
});
const queryClient = new QueryClient();
const Context = createContext(null);
const shortAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "");

export function useWallet() {
  return useContext(Context);
}

export function WalletProvider({ children }) {
  return (
    <WagmiProvider config={walletConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          <LiegeWalletProvider>{children}</LiegeWalletProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}

function LiegeWalletProvider({ children }) {
  const { address, connector, isConnected } = useAccount(),
    chainId = useChainId(),
    { disconnect: disconnectWallet } = useDisconnect(),
    { signMessageAsync } = useSignMessage(),
    { signTypedDataAsync } = useSignTypedData(),
    { sendTransactionAsync } = useSendTransaction(),
    { writeContractAsync } = useWriteContract();
  const [apiSession, setApiSession] = useState(null),
    [signingIn, setSigningIn] = useState(false),
    [error, setError] = useState("");
  const previousAddress = useRef(address);
  useEffect(() => {
    if (previousAddress.current !== address) {
      setApiSession(null);
      setError("");
      previousAddress.current = address;
    }
  }, [address]);
  const ready = Boolean(isConnected && address && chainId === robinhoodChain.id);
  useEffect(() => {
    let active = true;
    if (!ready || !address) return;
    api
      .me()
      .then((result) => {
        if (active && result.data?.wallet_address?.toLowerCase() === address.toLowerCase())
          setApiSession(result.data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [ready, address]);
  const signIn = async () => {
    if (!ready || !address) {
      setError("Connect a wallet on Robinhood Chain before signing in.");
      return;
    }
    setSigningIn(true);
    setError("");
    try {
      const session = await createWalletSession(address, (message) =>
        signMessageAsync({ message }),
      );
      const account = await api.me();
      setApiSession(account.data || session);
    } catch (e) {
      setError(e?.shortMessage || e?.message || "Wallet sign-in failed.");
    } finally {
      setSigningIn(false);
    }
  };
  const disconnect = () => {
    disconnectWallet();
    setApiSession(null);
    setError("");
  };
  const fundEscrow = async (jobId) => {
    if (!ready || !apiSession) throw new Error("Connect and sign in before funding.");
    const key = `liege.pending-funding.${jobId}`,
      pending = localStorage.getItem(key);
    if (pending) {
      try {
        const result = await api.fundJob("cookie", jobId, JSON.parse(pending));
        localStorage.removeItem(key);
        return result;
      } catch (error) {
        throw new Error(
          "Your prior deposits are still being verified. Do not send another deposit; retry shortly.",
        );
      }
    }
    const quote = await api.fundingQuote("cookie", jobId);
    const data = quote.data;
    const tokenAddress = data?.tokenAddress || data?.usdgTokenAddress;
    const amountRaw = data?.tokenAmountRaw || data?.usdgAmountRaw;
    if (!tokenAddress || !amountRaw)
      throw new Error("On-chain token escrow is not configured yet.");
    if (data.escrowMode === "veilora") {
      const terms = {
        ...data.terms,
        budget: BigInt(data.terms.budget),
        evaluatorFee: BigInt(data.terms.evaluatorFee),
        acceptBy: BigInt(data.terms.acceptBy),
        submitBy: BigInt(data.terms.submitBy),
        evaluateWithin: BigInt(data.terms.evaluateWithin),
        expiresAt: BigInt(data.terms.expiresAt),
      };
      const predicted = await rpcClient.readContract({
        address: data.factoryAddress,
        abi: veiloraFactoryAbi,
        functionName: "predictEscrow",
        args: [terms],
      });
      if (predicted.toLowerCase() !== data.escrowAddress.toLowerCase())
        throw new Error(
          "The predicted escrow does not match Liege's funding quote. Refresh the job and try again.",
        );
      let factoryTxHash;
      const created = await rpcClient.readContract({
        address: data.factoryAddress,
        abi: veiloraFactoryAbi,
        functionName: "isEscrow",
        args: [predicted],
      });
      if (!created) {
        factoryTxHash = await writeContractAsync({
          address: data.factoryAddress,
          abi: veiloraFactoryAbi,
          functionName: "create",
          args: [terms],
        });
        await rpcClient.waitForTransactionReceipt({ hash: factoryTxHash, confirmations: 1 });
      }
      const tokenHash = await writeContractAsync({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "transfer",
        args: [data.escrowAddress, BigInt(amountRaw)],
      });
      const funding = { quoteId: data.quoteId, factoryTxHash, tokenTxHash: tokenHash };
      localStorage.setItem(key, JSON.stringify(funding));
      try {
        const result = await api.fundJob("cookie", jobId, funding);
        localStorage.removeItem(key);
        return result;
      } catch (error) {
        throw new Error(
          "Your escrow and token transfer were sent and are being verified. Retry this funding action shortly; do not send another transfer.",
        );
      }
    }
    const gasHash = await sendTransactionAsync({
      to: data.escrowAddress,
      value: BigInt(data.gasReserveWei),
    });
    const tokenHash = await writeContractAsync({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "transfer",
      args: [data.escrowAddress, BigInt(amountRaw)],
    });
    const funding = { quoteId: data.quoteId, tokenTxHash: tokenHash, gasTxHash: gasHash };
    localStorage.setItem(key, JSON.stringify(funding));
    try {
      const result = await api.fundJob("cookie", jobId, funding);
      localStorage.removeItem(key);
      return result;
    } catch (error) {
      throw new Error(
        "Your deposits were sent and are being verified. Do not send another deposit; retry this funding action shortly.",
      );
    }
  };
  /**
   * Sends a top-up from the connected wallet to Liege's top-up address, then waits for Liege to
   * credit it. The transaction hash is kept until it is credited, so a reload never sends twice.
   */
  const topUp = async ({ asset, amount, address, token }) => {
    if (!ready || !apiSession) throw new Error("Connect and sign in before topping up.");
    const key = `liege.pending-topup.${asset}`;
    let txHash = localStorage.getItem(key);
    if (!txHash) {
      txHash = await writeContractAsync({
        address: token.address,
        abi: erc20Abi,
        functionName: "transfer",
        args: [address, parseUnits(String(amount), token.decimals)],
      });
      localStorage.setItem(key, txHash);
    }
    for (let attempt = 0; attempt < 60; attempt++) {
      const result = await api.claimTopup("cookie", txHash, asset);
      if (result.data) {
        localStorage.removeItem(key);
        return result.data;
      }
      // 202: not indexed or not confirmed yet.
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    throw new Error(
      "Your transfer was sent and is still confirming. Reopen this page to finish; do not send it again.",
    );
  };
  const submitVeiloraDelivery = async (
    jobId,
    escrowAddress,
    deliverable,
    evidence = [],
    factoryVersion = 1,
  ) => {
    if (!ready || !address)
      throw new Error("Connect your provider wallet on Robinhood Chain before submitting.");
    const pendingKey = `liege.pending-delivery.${jobId}`;
    let proof = null;
    try {
      proof = JSON.parse(localStorage.getItem(pendingKey) || "null");
    } catch {}
    if (!proof) {
      const termsHash = await rpcClient.readContract({
        address: escrowAddress,
        abi: veiloraEscrowAbi,
        functionName: "termsHash",
      });
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
      const domain = {
        name: "VeiloraEscrow",
        version: String(factoryVersion),
        chainId: 4663,
        verifyingContract: escrowAddress,
      };
      const types = {
        ProviderAction: [
          { name: "action", type: "bytes32" },
          { name: "termsHash", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
      };
      const actionHash = (action) => keccak256(stringToHex(action));
      const accepted = await rpcClient.readContract({
        address: escrowAddress,
        abi: veiloraEscrowAbi,
        functionName: "accepted",
      });
      if (!accepted) {
        const nonce = await rpcClient.readContract({
          address: escrowAddress,
          abi: veiloraEscrowAbi,
          functionName: "providerNonce",
        });
        const signature = await signTypedDataAsync({
          domain,
          types,
          primaryType: "ProviderAction",
          message: { action: actionHash("ACCEPT"), termsHash, nonce, deadline },
        });
        const hash = await writeContractAsync({
          address: escrowAddress,
          abi: veiloraEscrowAbi,
          functionName: "accept",
          args: [signature, deadline],
        });
        await rpcClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      }
      const saltBytes = crypto.getRandomValues(new Uint8Array(32));
      const salt = `0x${Array.from(saltBytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
      const deliverableCommit = keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }],
          [salt, keccak256(stringToHex(deliverable))],
        ),
      );
      const nonce = await rpcClient.readContract({
        address: escrowAddress,
        abi: veiloraEscrowAbi,
        functionName: "providerNonce",
      });
      const signature =
        factoryVersion === 2
          ? await signTypedDataAsync({
              domain,
              types: {
                ProviderSubmission: [
                  { name: "termsHash", type: "bytes32" },
                  { name: "deliverableCommit", type: "bytes32" },
                  { name: "nonce", type: "uint256" },
                  { name: "deadline", type: "uint64" },
                ],
              },
              primaryType: "ProviderSubmission",
              message: { termsHash, deliverableCommit, nonce, deadline },
            })
          : await signTypedDataAsync({
              domain,
              types,
              primaryType: "ProviderAction",
              message: { action: actionHash("SUBMIT"), termsHash, nonce, deadline },
            });
      const submitTxHash = await writeContractAsync({
        address: escrowAddress,
        abi: veiloraEscrowAbi,
        functionName: "markSubmitted",
        args: [deliverableCommit, signature, deadline],
      });
      await rpcClient.waitForTransactionReceipt({ hash: submitTxHash, confirmations: 1 });
      proof = { deliverableCommit, deliverableSalt: salt, submitTxHash };
      localStorage.setItem(pendingKey, JSON.stringify(proof));
    }
    const result = await api.submitJob("cookie", jobId, { deliverable, evidence, ...proof });
    localStorage.removeItem(pendingKey);
    return result;
  };
  const signMessage = (message) => signMessageAsync({ message });
  const signTypedData = (typedData) => signTypedDataAsync(typedData);
  const value = useMemo(
    () => ({
      session: {
        kind: connector?.name || null,
        address: address || null,
        chain: chainId ? `0x${chainId.toString(16)}` : null,
      },
      ready,
      apiSession,
      signingIn,
      error,
      signIn,
      disconnect,
      fundEscrow,
      topUp,
      submitVeiloraDelivery,
      signMessage,
      signTypedData,
    }),
    [
      connector?.name,
      address,
      chainId,
      ready,
      apiSession,
      signingIn,
      error,
      sendTransactionAsync,
      writeContractAsync,
      signMessageAsync,
      signTypedDataAsync,
      submitVeiloraDelivery,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function WalletButton() {
  const wallet = useWallet();
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal }) => {
        const active = mounted && account;
        if (!active)
          return (
            <button className="wallet-connect" onClick={openConnectModal}>
              <Wallet size={14} />
              <span>Connect wallet</span>
            </button>
          );
        if (chain?.unsupported || !wallet.ready)
          return (
            <button className="wallet-connect has-account" onClick={openChainModal}>
              <i className="wrong-network" />
              <span>Switch to Robinhood</span>
            </button>
          );
        return (
          <button
            className="wallet-connect has-account"
            onClick={wallet.apiSession ? openAccountModal : wallet.signIn}
          >
            {wallet.signingIn ? <LoaderCircle className="wallet-spin" size={14} /> : <i />}
            <span>
              {wallet.signingIn
                ? "Waiting for signature…"
                : wallet.apiSession
                  ? shortAddress(account.address)
                  : "Sign in to Liege"}
            </span>
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
