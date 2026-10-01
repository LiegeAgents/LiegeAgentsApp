export type Signer = (message: string) => Promise<string> | string;
export const SDK_VERSION = "0.1.5";

export interface X402PaymentRequired {
  x402Version: number;
  resource?: Record<string, unknown>;
  accepts: Array<Record<string, unknown>>;
  [key: string]: unknown;
}
export type X402PaymentPayload = Record<string, unknown>;
export type X402Signer = (
  challenge: X402PaymentRequired,
) => Promise<string | X402PaymentPayload> | string | X402PaymentPayload;

export interface Session { token: string; userId: string; walletAddress: string; expiresAt?: string; }
export interface Job { id: string; status: string; [key: string]: unknown; }
export interface Invoice { id: string; invoiceId: string; publicId: string; amountUsdg: number; asset: "usdg"; status: string; [key: string]: unknown; }
export interface JobEvent { id: string; event: string; data: unknown; }
export interface McpProposal { id: string; status: string; [key: string]: unknown; }

export class LiegeAPIError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message); this.name = "LiegeAPIError";
  }
}
