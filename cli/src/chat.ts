import { createInterface } from "node:readline";
import { linkedAccessToken } from "./credentials.js";
import { getApiUrl, getSessionToken, NOT_SIGNED_IN, request, type Json } from "./index.js";

// Interactive Super Agents chat (`liege --spg`). It only drafts proposals: approval,
// funding, and signing stay in the Super Agents dashboard, exactly as for the web chatbot.

export const getDashboardUrl = () =>
  (process.env.LIEGE_SUPERAGENTS_URL ?? "https://superagents.liegeagents.com").replace(/\/$/, "");

const TERMINAL_JOB_STATUSES = new Set(["completed", "rejected", "expired", "cancelled"]);

type Draft = {
  agentName: string | null;
  request: string;
  settlementAsset: "usdg" | "liege";
  budgetAmount: number | null;
  budgetUsdg: number | null;
  deadlineAt: string | null;
};

type Agent = { id: string; name: string; slug?: string; price_usd?: string; sla_minutes?: number };

type Tracked = { intentStatus: string; jobId: string | null; jobStatus: string | null };

const useColor = () => Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) =>
  useColor() ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const cyan = paint("36");

const budgetOf = (draft: Draft) => draft.budgetAmount ?? draft.budgetUsdg;

const sameName = (agent: Agent, name: string) => {
  const wanted = name.trim().toLowerCase();
  const short = agent.name.replace(/ by LiegeAgents$/i, "").toLowerCase();
  return (
    agent.name.toLowerCase() === wanted ||
    short === wanted ||
    agent.slug?.toLowerCase() === wanted.replace(/[^a-z0-9]+/g, "-")
  );
};

export function describeDraft(draft: Draft, agents: Agent[]) {
  const budget = budgetOf(draft);
  const agent = draft.agentName ? agents.find((item) => sameName(item, draft.agentName!)) : null;
  const missing: string[] = [];
  if (!draft.agentName) missing.push("which Super Agent to hire");
  else if (agents.length && !agent)
    missing.push(`an available agent (${draft.agentName} is not an enrolled Super Agent)`);
  if (!budget) missing.push(`a ${draft.settlementAsset.toUpperCase()} budget`);
  const lines = [
    bold("Draft proposal"),
    `  Agent     ${agent?.name ?? draft.agentName ?? dim("not specified")}`,
    `  Request   ${draft.request}`,
    `  Budget    ${budget ? `${budget} ${draft.settlementAsset.toUpperCase()}` : dim("not specified")}`,
    `  Deadline  ${draft.deadlineAt ?? dim(agent?.sla_minutes ? `service SLA (${agent.sla_minutes} min)` : "service SLA")}`,
  ];
  return { lines, missing, complete: missing.length === 0 };
}

export const chatHelp = () => [
  bold("Describe the work in plain English, for example:"),
  dim('  "Hire Anna to write a cited brief on Solana DEX volumes, budget 5 USDG"'),
  "",
  bold("Commands"),
  "  /agents          List Super Agents you can hire",
  "  /proposals       Show your recent proposals and their status",
  "  /jobs            Show your recent Super Agent jobs",
  "  /job <job-id>    Show one job",
  "  /new             Discard the current draft",
  "  /help            Show this help",
  "  /exit            Leave the chat",
  "",
  dim(`Proposals are approved and funded in ${getDashboardUrl()}/app?view=requests`),
];

export class ChatSession {
  agents: Agent[] = [];
  pendingText: string | null = null;
  awaitingConfirmation: { text: string } | null = null;
  tracked = new Map<string, Tracked>();
  closed = false;

  constructor(private write: (line: string) => void) {}

  async start() {
    const dashboard = (await request("/v1/super-agents/dashboard")) as Json;
    this.agents = (dashboard.agents as Agent[] | undefined) ?? [];
    this.write(`${bold("Liege Super Agents")} ${dim(`· ${getApiUrl()}`)}`);
    this.write(
      dim("Hire agents in plain English. Approval and funding stay in your Liege dashboard."),
    );
    this.write(
      dim(
        `${this.agents.length} Super Agent${this.agents.length === 1 ? "" : "s"} available. Type /help for commands, /exit to quit.`,
      ),
    );
  }

  async handle(raw: string) {
    const line = raw.trim();
    if (!line) return;
    if (this.awaitingConfirmation) return this.confirm(line);
    if (line.startsWith("/")) return this.command(line);
    const text = this.pendingText ? `${this.pendingText}\n${line}` : line;
    const draft = (await request("/v1/super-agents/intents/parse", {
      method: "POST",
      body: JSON.stringify({ text }),
    })) as Draft;
    const { lines, missing, complete } = describeDraft(draft, this.agents);
    lines.forEach((item) => this.write(item));
    if (!complete) {
      this.pendingText = text;
      this.write(yellow(`Still needed: ${missing.join(" and ")}. Reply with the details.`));
      return;
    }
    this.awaitingConfirmation = { text };
    this.write(`Send this proposal to your dashboard for approval? ${dim("[y/N]")}`);
  }

  private async confirm(line: string) {
    const { text } = this.awaitingConfirmation!;
    this.awaitingConfirmation = null;
    if (!/^y(es)?$/i.test(line)) {
      this.pendingText = text;
      this.write(dim("Not sent. Add details to refine the draft, or /new to start over."));
      return;
    }
    this.pendingText = null;
    const intent = (await request("/v1/super-agents/intents", {
      method: "POST",
      body: JSON.stringify({ text, source: "cli" }),
    })) as Json;
    this.tracked.set(String(intent.id), { intentStatus: "pending", jobId: null, jobStatus: null });
    this.write(green(`Proposal ${intent.id} is waiting for your approval.`));
    this.write(`Approve or reject it at ${cyan(`${getDashboardUrl()}/app?view=requests`)}`);
    this.write(dim("Updates will appear here while the chat is open."));
  }

  private async command(line: string) {
    const [name, arg] = line.slice(1).split(/\s+/);
    switch (name.toLowerCase()) {
      case "help":
      case "?":
        chatHelp().forEach((item) => this.write(item));
        return;
      case "exit":
      case "quit":
        this.closed = true;
        return;
      case "new":
      case "clear":
        this.pendingText = null;
        this.write(dim("Draft discarded."));
        return;
      case "agents": {
        const dashboard = (await request("/v1/super-agents/dashboard")) as Json;
        this.agents = (dashboard.agents as Agent[] | undefined) ?? [];
        if (!this.agents.length) this.write(dim("No Super Agents are available right now."));
        for (const agent of this.agents)
          this.write(
            `  ${bold(agent.name)}${agent.price_usd ? dim(` · from ${agent.price_usd} USD`) : ""}${agent.sla_minutes ? dim(` · SLA ${agent.sla_minutes} min`) : ""}`,
          );
        return;
      }
      case "proposals": {
        const intents = ((await request("/v1/super-agents/intents")) as Json[]).slice(0, 10);
        if (!intents.length) this.write(dim("No proposals yet."));
        for (const intent of intents)
          this.write(
            `  ${dim(String(intent.id).slice(0, 8))}  ${intentStatus(intent).padEnd(9)} ${intent.agent_name ?? "unmatched"}: ${String((intent.parsed as Json | undefined)?.request ?? intent.raw_text).slice(0, 60)}`,
          );
        return;
      }
      case "jobs": {
        const dashboard = (await request("/v1/super-agents/dashboard")) as Json;
        const jobs = ((dashboard.jobs as Json[] | undefined) ?? []).slice(0, 10);
        if (!jobs.length) this.write(dim("No Super Agent jobs yet."));
        for (const job of jobs)
          this.write(
            `  ${dim(String(job.id))}  ${String(job.status).padEnd(9)} ${String(job.title).slice(0, 60)}`,
          );
        return;
      }
      case "job": {
        if (!arg) {
          this.write(yellow("Usage: /job <job-id>"));
          return;
        }
        const job = (await request(`/v1/jobs/${encodeURIComponent(arg)}`)) as Json;
        this.write(`  ${bold(String(job.title))}`);
        this.write(`  Status    ${job.status}`);
        this.write(
          `  Budget    ${job.budget_amount ?? job.budget_usdg} ${String(job.settlement_asset ?? "usdg").toUpperCase()}`,
        );
        if (job.deadline_at) this.write(`  Deadline  ${job.deadline_at}`);
        return;
      }
      default:
        this.write(yellow(`Unknown command /${name}. Type /help for commands.`));
    }
  }

  // Reports proposal decisions made in the dashboard and job progress for proposals sent
  // from this session.
  async poll() {
    if (!this.tracked.size) return;
    const intents = (await request("/v1/super-agents/intents")) as Json[];
    for (const intent of intents) {
      const id = String(intent.id);
      const state = this.tracked.get(id);
      if (!state) continue;
      const status = intentStatus(intent);
      if (status !== state.intentStatus) {
        state.intentStatus = status;
        if (status === "approved")
          this.write(green(`Proposal ${id.slice(0, 8)} was approved in the dashboard.`));
        else this.write(yellow(`Proposal ${id.slice(0, 8)} is ${status}.`));
        if (status !== "approved") this.tracked.delete(id);
      }
      const jobId = intent.job_id ? String(intent.job_id) : null;
      const jobStatus = intent.job_status ? String(intent.job_status) : null;
      if (jobId && jobStatus !== state.jobStatus) {
        state.jobId = jobId;
        state.jobStatus = jobStatus;
        this.write(`Job ${cyan(jobId)} is ${bold(jobStatus ?? "open")}${jobHint(jobStatus)}`);
        if (jobStatus && TERMINAL_JOB_STATUSES.has(jobStatus)) this.tracked.delete(id);
      }
    }
  }
}

function intentStatus(intent: Json) {
  const status = String(intent.status);
  if (
    status === "pending" &&
    intent.expires_at &&
    new Date(String(intent.expires_at)) <= new Date()
  )
    return "expired";
  return status;
}

function jobHint(status: string | null) {
  if (status === "open") return dim(" (fund it in the dashboard to start work)");
  if (status === "funded") return dim(" (the agent is working on it)");
  if (status === "submitted") return dim(" (review the deliverable in the dashboard)");
  return "";
}

export async function startChat() {
  if (!getSessionToken() && !(await linkedAccessToken(getApiUrl()))) throw new Error(NOT_SIGNED_IN);
  let wrote = false;
  const write = (line: string) => {
    wrote = true;
    // Clear the in-progress prompt line so asynchronous updates don't interleave with it.
    if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
    console.log(line);
  };
  const session = new ChatSession(write);
  await session.start();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  rl.setPrompt(cyan("› "));
  // Piped input ends before queued lines are handled, so prompting must stop at EOF.
  let inputClosed = false;
  rl.on("close", () => {
    inputClosed = true;
  });
  const prompt = (preserveCursor = false) => {
    if (!inputClosed) rl.prompt(preserveCursor);
  };
  const pollMs = Number(process.env.LIEGE_CHAT_POLL_MS ?? 5_000);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      wrote = false;
      await session.poll();
      if (wrote) prompt(true);
    } catch {
      // Polling failures are transient; the next tick retries.
    } finally {
      busy = false;
    }
  }, pollMs);

  prompt();
  try {
    for await (const line of rl) {
      busy = true;
      try {
        await session.handle(line);
      } catch (error) {
        write(yellow(`Error: ${error instanceof Error ? error.message : String(error)}`));
      } finally {
        busy = false;
      }
      if (session.closed) break;
      prompt();
    }
  } finally {
    clearInterval(timer);
    rl.close();
  }
}
