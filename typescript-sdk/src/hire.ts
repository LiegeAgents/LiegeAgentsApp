import { LiegeClient, type LiegeClientOptions } from "./api.js";
import { LiegeAPIError } from "./types.js";

export interface LiegeHireClientOptions extends Omit<LiegeClientOptions, "token"> {
  /** A hiring key (lmh_…) from Liege Super Agents → Hiring keys. */
  hireKey: string;
}

/** A Super Agent that can be hired, from Liege's A2A agent card. */
export interface HireableAgent {
  /** The agent's slug; pass it as `agent` to `hire`. */
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export type HireTaskState =
  "submitted" | "working" | "completed" | "rejected" | "canceled" | "failed";

export interface HireTask {
  /** The proposal id, which is also the A2A task id. */
  id: string;
  state: HireTaskState;
  /** What is happening now, e.g. waiting for the key owner's approval. */
  message: string;
  /** The delivered work once the agent has submitted it. */
  deliverable: string | null;
  proposalStatus: string | null;
  jobId: string | null;
  jobStatus: string | null;
}

const finished: HireTaskState[] = ["completed", "rejected", "canceled", "failed"];

/**
 * Hires Liege Super Agents with a hiring key over Liege's A2A endpoint. Each hire is a proposal
 * the key's owner approves and funds in Liege, within the key's USDG limits; this client never
 * approves or pays.
 */
export class LiegeHireClient {
  private readonly client: LiegeClient;

  constructor(options: LiegeHireClientOptions) {
    const { hireKey, ...rest } = options;
    if (!hireKey?.startsWith("lmh_"))
      throw new LiegeAPIError("A Liege hiring key (lmh_…) is required.", 401, "invalid_hire_key");
    this.client = new LiegeClient({ ...rest, token: hireKey });
  }

  /** Super Agents that can be hired now. */
  async agents(): Promise<HireableAgent[]> {
    const card = await this.client.request<{ skills: HireableAgent[] }>(
      "/.well-known/agent-card.json",
    );
    return card.skills.map(({ id, name, description, tags }) => ({ id, name, description, tags }));
  }

  /**
   * Proposes work. Name the agent with `agent` (a slug from `agents()`) or in the text
   * ("Hire Scott to …"). Without `budget`, the agent's listed USDG price is proposed.
   */
  hire(request: string, options: { agent?: string; budget?: number } = {}): Promise<HireTask> {
    return this.rpc("message/send", options.agent, {
      message: {
        role: "user",
        messageId: globalThis.crypto.randomUUID(),
        parts: [{ kind: "text", text: request }],
      },
      ...(options.budget === undefined ? {} : { metadata: { budgetAmount: options.budget } }),
    });
  }

  /** The current state of a hire. */
  task(id: string): Promise<HireTask> {
    return this.rpc("tasks/get", undefined, { id });
  }

  /**
   * Polls until the hire is completed, rejected, canceled, or failed. Approval and funding are
   * done by a person, so allow for that in `timeoutMs` (default 30 minutes).
   */
  async waitForResult(
    id: string,
    options: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal } = {},
  ): Promise<HireTask> {
    const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
    for (;;) {
      const task = await this.task(id);
      if (finished.includes(task.state)) return task;
      if (options.signal?.aborted)
        throw new LiegeAPIError("Waiting for the hire was aborted.", 408, "request_aborted");
      if (Date.now() >= deadline)
        throw new LiegeAPIError(
          `The hire is still ${task.state}: ${task.message}`,
          408,
          "hire_wait_timeout",
        );
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 10_000));
    }
  }

  private async rpc(method: string, agent: string | undefined, params: unknown) {
    const path = agent ? `/v1/a2a/${encodeURIComponent(agent)}` : "/v1/a2a";
    const body = await this.client.request<{
      result?: Record<string, any>;
      error?: { code: number; message: string; data?: { code?: string } };
    }>(path, { method: "POST", body: { jsonrpc: "2.0", id: 1, method, params } });
    if (body.error)
      throw new LiegeAPIError(
        body.error.message,
        body.error.code === -32001 ? 404 : 422,
        body.error.data?.code ?? (body.error.code === -32001 ? "task_not_found" : "a2a_error"),
      );
    return toTask(body.result!);
  }
}

function toTask(task: Record<string, any>): HireTask {
  const meta = task.metadata ?? {};
  const text = (parts: Array<{ kind: string; text?: string }> = []) =>
    parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("\n");
  return {
    id: task.id,
    state: task.status.state,
    message: text(task.status.message?.parts),
    deliverable: task.artifacts?.length ? text(task.artifacts[0].parts) : null,
    proposalStatus: meta.proposalStatus ?? null,
    jobId: meta.jobId ?? null,
    jobStatus: meta.jobStatus ?? null,
  };
}
