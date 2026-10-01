export type Signer = (message: string) => Promise<string> | string;
export const SDK_VERSION = "0.1.4";

export interface Session { token: string; userId: string; walletAddress: string; expiresAt?: string; }
export interface Job { id: string; status: string; [key: string]: unknown; }
export interface JobEvent { id: string; event: string; data: unknown; }
export interface McpProposal { id: string; status: string; [key: string]: unknown; }

export class LiegeAPIError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message); this.name = "LiegeAPIError";
  }
}
