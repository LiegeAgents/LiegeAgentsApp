export type Signer = (message: string) => Promise<string> | string;
export const SDK_VERSION = "0.1.9";

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
export type InvoiceAsset = "usdg" | "liege";
export interface Invoice {
  id: string;
  invoiceId: string;
  publicId: string;
  amount?: number;
  amountUsdg: number;
  refundedAmount?: number;
  refundedAmountUsdg?: number;
  remainingAmount?: number;
  asset: InvoiceAsset | string;
  status: string;
  [key: string]: unknown;
}
export interface InvoiceRefund {
  id: string;
  invoiceId: string;
  payerId: string;
  issuerId: string;
  amount: number;
  amountUsdg: number;
  asset: InvoiceAsset | string;
  jobId?: string | null;
  reason?: string | null;
  refundedAt: string;
  ledgerTransactionId: string;
  [key: string]: unknown;
}
export interface RefundInvoiceInput {
  amount?: string | number;
  amountUsdg?: string | number;
  jobId?: string;
  reason?: string;
}
export type ServiceType = "tool" | "data" | "skill";
export type ServiceExecutionMode = "manual" | "sandboxed_runner";
export interface Service {
  id: string; agentId: string; slug: string; name: string; description: string;
  serviceType: ServiceType; executionMode: ServiceExecutionMode; priceUsd: number;
  slaMinutes: number; requirementsSchema: Record<string, unknown>; deliverableSchema: Record<string, unknown>;
  [key: string]: unknown;
}
export type AgentStatus = "active" | "paused" | "killed";
export type ApprovalMode = "always" | "within_policy";
export interface AgentPolicy {
  version: number; maxActionAmount: string | null; dailyBudget: string | null; monthlyBudget: string | null;
  allowedAssets: string[]; allowedVenues: string[]; approvedCounterparties: string[]; allowedActions: string[];
  approvalMode: ApprovalMode; simulationRequired: boolean; requireHumanAbove: string | null;
  activeHours: { start: number; end: number } | null; activeDays: number[]; timezone: string;
}
export interface AgentAccount { accountId: string; agentId: string; status: AgentStatus; killReason?: string | null; pausedAt?: string | null; policy: AgentPolicy | null; [key: string]: unknown; }
export interface AgentPolicyInput {
  maxActionAmount?: string | number | null; dailyBudget?: string | number | null; monthlyBudget?: string | number | null;
  allowedAssets?: string[]; allowedVenues?: string[]; approvedCounterparties?: string[]; allowedActions?: string[];
  approvalMode?: ApprovalMode; simulationRequired?: boolean; requireHumanAbove?: string | number | null;
  activeHours?: { start: number; end: number } | null; activeDays?: number[]; timezone?: string;
}
export interface AgentActionInput {
  action: string; amount?: string | number; asset?: string; venue?: string; counterparty?: string;
  details?: Record<string, unknown>; simulationId?: string; simulationDigest?: string; simulate?: boolean;
}
export interface AgentActionSimulation { id: string; actionDigest: string; action: Record<string, unknown>; result: Record<string, unknown>; policyVersion: number; expiresAt: string; createdAt: string; [key: string]: unknown; }
export interface AgentActionAuthorization { actionId: string; accountId: string; decision: string; reasons: string[]; policyVersion: number; simulationDigest: string | null; createdAt: string; [key: string]: unknown; }
export interface AgentControlResult { accountId: string; status: AgentStatus; killReason?: string | null; revokedConnections: number; rejectedProposals: number; [key: string]: unknown; }
export type RunnerCommand = "node" | "bun" | "python" | "python3";
export interface RunnerInput {
  agentId: string; jobId?: string; command: RunnerCommand; args?: string[];
  env?: Record<string, string>; files?: Record<string, string>; artifactPaths?: string[];
  timeoutMs?: number; maxOutputBytes?: number; actionId?: string; simulationId?: string;
}
export interface RunnerArtifact { id?: string; name: string; sizeBytes?: number; sha256: string; createdAt?: string; contentBase64?: string; [key: string]: unknown; }
export interface RunnerResult {
  id: string; agentId?: string; jobId?: string | null; command?: RunnerCommand; args?: string[];
  status: string; exitCode?: number | null; stdout?: string | null; stderr?: string | null;
  error?: string | null; timeoutMs?: number; maxOutputBytes?: number; startedAt?: string;
  finishedAt?: string | null; createdAt?: string; artifacts: RunnerArtifact[]; [key: string]: unknown;
}
export interface JobEvent { id: string; event: string; data: unknown; }
export interface EventStreamOptions {
  after?: string;
  since?: Date;
  maxRetries?: number;
  backoffMs?: number;
}
export interface McpProposal { id: string; status: string; [key: string]: unknown; }

export interface ReceiptSubject {
  type: "job" | "invoice";
  id: string;
  publicId: string;
  title: string;
  agentName: string;
}

export interface Receipt {
  receiptId: string;
  type: string;
  asset?: string;
  availableChange?: string;
  stakeChange?: string;
  reference: string;
  subject: ReceiptSubject | null;
  createdAt: string;
  lines?: Array<{ asset: string; availableChange: string; stakeChange: string }>;
  digest?: string;
  [key: string]: unknown;
}

export interface StatementResponse {
  data: Receipt[];
  digest: string;
  generatedAt: string;
}

export interface OtelSpanAttribute {
  key: string;
  value: { stringValue?: string; doubleValue?: number; intValue?: number };
}

export interface OtelSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtelSpanAttribute[];
  status: { code: string };
}

export interface OtelTraceExport {
  resourceSpans: Array<{
    resource: { attributes: OtelSpanAttribute[] };
    scopeSpans: Array<{
      scope: { name: string; version: string };
      spans: OtelSpan[];
    }>;
  }>;
  digest: string;
  generatedAt: string;
}

export interface AgentMandate {
  id: string;
  agent_id: string;
  parent_mandate_id?: string | null;
  nonce: string;
  digest: string;
  payload: Record<string, unknown>;
  signature: string;
  status: string;
  expires_at: string;
  revoked_at?: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface Ap2MandateConstraints {
  type: string;
  allowed_actions: string[];
  max_amount: string | null;
  daily_budget: string | null;
  monthly_budget: string | null;
  currency: string;
  allowed_assets: string[];
  allowed_payees: string[];
  allowed_venues: string[];
}

export interface Ap2MandateExport {
  protocol: "ap2";
  version: "0.2";
  vct: string;
  mandate_id: string;
  agent_id: string;
  status: string;
  issuer: {
    id: string;
    address: string;
    chain_id: number;
    network: string;
  };
  subject: {
    agent_id: string;
    account_id: string;
  };
  "ap2.mandates.PaymentMandate": {
    mandate_id: string;
    parent_mandate_id: string | null;
    creation_time: string;
    expiration_time: string;
    nonce: string;
    constraints: Ap2MandateConstraints;
    payload: Record<string, unknown>;
  };
  "ap2.mandates.IntentMandate": {
    natural_language_description: string;
    user_cart_confirmation_required: boolean;
    requires_refundability: boolean;
    intent_expiry: string;
    merchants: string[];
    constraints: {
      max_amount: string | null;
      currency: string;
      allowed_assets: string[];
    };
  };
  proof: {
    type: string;
    verification_method: string;
    created: string;
    proof_purpose: string;
    digest: string;
    signature: string;
  };
}

export type McpHarnessTarget = "claude_desktop" | "cursor" | "elizaos" | "hermes" | "openclaw";

export interface McpHarnessPreset {
  id: McpHarnessTarget;
  name: string;
  target: McpHarnessTarget;
  filename: string;
  description: string;
  instructions: string;
  format: "json";
  config: Record<string, unknown>;
}

export interface McpHarnessPresetsResponse {
  connectionId?: string;
  agentId?: string;
  agentName?: string;
  connectionName?: string;
  serverUrl: string;
  presets: Record<McpHarnessTarget, McpHarnessPreset>;
}

export class LiegeAPIError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message); this.name = "LiegeAPIError";
  }
}

