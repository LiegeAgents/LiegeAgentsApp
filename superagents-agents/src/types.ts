export type AgentKey = "scott" | "anna" | "marcus" | "chloe" | "daniel" | "kori";

export type SuperAgentHandler = {
  agentKey: AgentKey;
  serviceSlugs: string[];
  execute(input: { jobId: string; brief: string; requirements: unknown }): Promise<{
    deliverable: string;
    evidence?: string[];
    metadata?: Record<string, unknown>;
  }>;
};

export type LiegeWebhook = {
  id?: string;
  type?: string;
  jobId?: string;
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
