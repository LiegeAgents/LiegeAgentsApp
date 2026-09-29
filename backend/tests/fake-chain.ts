import { hexToString, keccak256, toHex, type Address, type Hash, type Hex } from "viem";
import type { EscrowAsset, EscrowChain, ReceiptStatus } from "../src/escrow.js";

type Transaction = {
  from: string;
  to: string;
  asset: EscrowAsset;
  amount: string;
  nonce: number;
  salt: number;
};
type Balances = { usdg: bigint; eth: bigint };

// Gas cost of every transaction, paid in ETH by the sender.
export const GAS_COST = 1_000n;

// An in-memory chain with nonces, balances, reverts, and held transactions. A fault can be
// injected before or after any call, simulating a crash or lost response at that point.
export class FakeChain implements EscrowChain {
  readonly mined: (Transaction & { hash: Hash; status: "success" | "reverted" })[] = [];
  holdBroadcasts = false;
  calls = 0;
  private balances = new Map<string, Balances>();
  private nonces = new Map<string, number>();
  private receipts = new Map<Hash, "success" | "reverted">();
  private fault: { at: number; when: "before" | "after" } | null = null;
  private salt = 0;

  credit(address: string, amounts: Partial<Balances>) {
    const balance = this.balanceOf(address);
    balance.usdg += amounts.usdg ?? 0n;
    balance.eth += amounts.eth ?? 0n;
  }

  balanceOf(address: string) {
    const key = address.toLowerCase();
    if (!this.balances.has(key)) this.balances.set(key, { usdg: 0n, eth: 0n });
    return this.balances.get(key)!;
  }

  // Another signer spends the wallet's next nonce.
  spendNonce(address: string) {
    const key = address.toLowerCase();
    this.nonces.set(key, (this.nonces.get(key) ?? 0) + 1);
  }

  failAt(call: number, when: "before" | "after") {
    this.calls = 0;
    this.fault = { at: call, when };
  }

  private async step<T>(operation: () => T): Promise<T> {
    const call = this.calls++;
    const fault = this.fault?.at === call ? this.fault : null;
    if (fault) this.fault = null;
    if (fault?.when === "before") throw new Error(`Injected fault before call ${call}.`);
    const result = operation();
    if (fault?.when === "after") throw new Error(`Injected fault after call ${call}.`);
    return result;
  }

  transactionCount(address: Address) {
    return this.step(() => this.nonces.get(address.toLowerCase()) ?? 0);
  }

  sign(
    account: { address: Address },
    payout: { asset: EscrowAsset; to: Address; amount: bigint | "all"; nonce: number },
  ) {
    return this.step(() => {
      const balance = this.balanceOf(account.address);
      const amount =
        payout.amount !== "all"
          ? payout.amount
          : payout.asset === "usdg"
            ? balance.usdg
            : balance.eth - GAS_COST;
      if (amount <= 0n) return null;
      const transaction: Transaction = {
        from: account.address.toLowerCase(),
        to: payout.to.toLowerCase(),
        asset: payout.asset,
        amount: amount.toString(),
        nonce: payout.nonce,
        salt: this.salt++,
      };
      const raw = toHex(JSON.stringify(transaction));
      return { raw, hash: keccak256(raw), amount };
    });
  }

  broadcast(raw: Hex) {
    return this.step(() => {
      const hash = keccak256(raw);
      if (this.receipts.has(hash) || this.holdBroadcasts) return;
      const transaction: Transaction = JSON.parse(hexToString(raw));
      const nonce = this.nonces.get(transaction.from) ?? 0;
      if (transaction.nonce !== nonce)
        throw new Error(transaction.nonce < nonce ? "nonce too low" : "nonce too high");
      const from = this.balanceOf(transaction.from);
      const amount = BigInt(transaction.amount);
      if (from.eth < GAS_COST + (transaction.asset === "eth" ? amount : 0n))
        throw new Error("insufficient funds for gas * price + value");
      this.nonces.set(transaction.from, nonce + 1);
      from.eth -= GAS_COST;
      const status = from[transaction.asset] >= amount ? "success" : "reverted";
      if (status === "success") {
        from[transaction.asset] -= amount;
        this.balanceOf(transaction.to)[transaction.asset] += amount;
      }
      this.receipts.set(hash, status);
      this.mined.push({ ...transaction, hash, status });
    });
  }

  receipt(hash: Hash) {
    return this.step((): ReceiptStatus => this.receipts.get(hash) ?? null);
  }

  waitForReceipt(hash: Hash) {
    return this.step((): ReceiptStatus => this.receipts.get(hash) ?? null);
  }
}
