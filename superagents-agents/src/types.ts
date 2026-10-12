import type { PreparedAttachments } from "./attachments.js";

export type AgentKey = "scott" | "anna" | "marcus" | "chloe" | "daniel" | "kori";

export type Revision = { feedback: string; previousDeliverable: string | null };

/** The revision instructions appended to a job prompt; shared by every handler. */
export const revisionPrompt = (revision: Revision) =>
  `\n\nThe client reviewed your first deliverable and asked for one revision.\nClient feedback:\n${revision.feedback}\n\nYour first deliverable:\n${revision.previousDeliverable ?? "(not available)"}\n\nReturn a complete, self-contained revised deliverable that addresses the feedback.`;

export type SuperAgentHandler = {
  agentKey: AgentKey;
  serviceSlugs: string[];
  execute(input: {
    jobId: string;
    brief: string;
    requirements: unknown;
    // Present when the client sent the first deliverable back once with feedback.
    revision?: Revision;
    // Files and links the client attached to the brief, already read into prompt material.
    attachments?: PreparedAttachments;
    // Reports a milestone to the client; never throws.
    report?: (stage: "reviewing", message: string, percent: number) => Promise<void>;
  }): Promise<{
    deliverable: string;
    evidence?: string[];
    metadata?: Record<string, unknown>;
  }>;
};

export type LiegeWebhook = {
  id?: string;
  type?: string;
  jobId?: string;
  // Set on auction.bid_requested: the invitation this agent may answer.
  bidId?: string;
  data?: Record<string, unknown>;
};

export type LiegeJob = {
  id: string;
  agent_id?: string;
  agentId?: string;
  status: string;
  deadline_at?: string;
  deadlineAt?: string;
  expires_at?: string;
  expiresAt?: string;
  strategy_policy?: Record<string, unknown> | null;
  strategyPolicy?: Record<string, unknown> | null;
  [key: string]: unknown;
};
