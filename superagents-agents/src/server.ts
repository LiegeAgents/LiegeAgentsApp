import { createHmac, timingSafeEqual } from "node:crypto";
import { answerCall } from "./calls.js";
import { config } from "./config.js";
import {
  claimEvent,
  completeEvent,
  declineJob,
  getAttachments,
  getBid,
  getRevision,
  submitBid,
  reportProgress,
  getBrief,
  getJob,
  publishSigningKey,
  submitDeliverable,
} from "./liege-client.js";
import { signDeliverable } from "./signing.js";
import { prepareAttachments } from "./attachments.js";
import { prepareBid } from "./bidding.js";
import { githubPolicy, postReviewComment } from "./githubComments.js";
import { handlers } from "./handlers.js";
import type { AgentKey, LiegeWebhook } from "./types.js";

const processed = new Map<string, number>();
const running = new Set<string>();
const maxProcessed = 10_000;

function verify(body: string, signature: string | null, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(signature.slice(7), "hex");
  const actual = createHmac("sha256", secret).update(body).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function agentForPath(pathname: string) {
  const key = pathname.split("/").filter(Boolean).at(-1) as AgentKey | undefined;
  return key && key in config.agents ? key : null;
}

function cleanProcessed() {
  const now = Date.now();
  for (const [id, timestamp] of processed) if (now - timestamp > 86_400_000) processed.delete(id);
  while (processed.size > maxProcessed) processed.delete(processed.keys().next().value as string);
}

async function execute(agentKey: AgentKey, eventId: string, event: LiegeWebhook) {
  const jobId = event.jobId;
  if (!jobId) throw new Error("Webhook event has no jobId.");
  if (processed.has(eventId) || running.has(jobId))
    return { status: "ignored" as const, reason: "duplicate_or_running" };
  running.add(jobId);
  try {
    const job = await getJob(jobId);
    const configuredAgent = config.agents[agentKey];
    const assignedAgent = String(job.agentId ?? job.agent_id ?? "");
    if (assignedAgent !== configuredAgent.id)
      return { status: "ignored" as const, reason: "job_assigned_to_different_agent" };
    if (job.status !== "funded") return { status: "ignored" as const, reason: `job_${job.status}` };
    const receipt = await claimEvent(eventId, configuredAgent.id);
    if (!receipt.claimed) return { status: "ignored" as const, reason: "durable_duplicate" };
    const deadline = new Date(job.deadlineAt ?? job.deadline_at ?? 0);
    const expires = new Date(job.expiresAt ?? job.expires_at ?? 0);
    if (Number.isNaN(deadline.getTime()) || deadline <= new Date()) {
      await declineJob(jobId, "The delivery deadline has passed before execution could begin.");
      await completeEvent(eventId, configuredAgent.id);
      processed.set(eventId, Date.now());
      cleanProcessed();
      return { status: "declined" as const, reason: "job_deadline_passed", jobId, agentKey };
    }
    if (Number.isNaN(expires.getTime()) || expires <= new Date()) {
      await declineJob(jobId, "The job expired before execution could begin.");
      await completeEvent(eventId, configuredAgent.id);
      processed.set(eventId, Date.now());
      cleanProcessed();
      return { status: "declined" as const, reason: "job_expired", jobId, agentKey };
    }
    const policy = job.strategyPolicy ?? job.strategy_policy ?? {};
    const serviceSlug = typeof policy.serviceSlug === "string" ? policy.serviceSlug : undefined;
    const handler = handlers[agentKey];
    if (serviceSlug && !handler.serviceSlugs.includes(serviceSlug)) {
      await declineJob(
        jobId,
        `The runtime does not support the requested service: ${serviceSlug}.`,
      );
      await completeEvent(eventId, configuredAgent.id);
      processed.set(eventId, Date.now());
      cleanProcessed();
      return { status: "declined" as const, reason: "unknown_service", jobId, agentKey };
    }
    // Milestones mark real steps only; the agents do not claim work they have not done.
    const name = agentKey.charAt(0).toUpperCase() + agentKey.slice(1);
    const revising = event.type === "job.revision_requested";
    await reportProgress(
      jobId,
      "started",
      revising ? `${name} received your revision feedback.` : `${name} picked up your job.`,
      10,
    );
    const brief = await getBrief(jobId);
    const revision = revising ? await getRevision(jobId) : undefined;
    const files = await getAttachments(jobId);
    if (files.length)
      await reportProgress(
        jobId,
        "researching",
        `${name} is reading your ${files.length} attachment${files.length === 1 ? "" : "s"}.`,
        25,
      );
    const attachments = files.length ? await prepareAttachments(files) : undefined;
    await reportProgress(
      jobId,
      "drafting",
      revising
        ? `${name} is revising your deliverable based on your feedback.`
        : `${name} is working on your deliverable.`,
      40,
    );
    const result = await handler.execute({
      jobId,
      brief,
      requirements: policy,
      revision,
      attachments,
      report: (stage, message, percent) => reportProgress(jobId, stage, message, percent),
    });
    if (result.decline) {
      await declineJob(jobId, result.decline);
      await completeEvent(eventId, configuredAgent.id);
      processed.set(eventId, Date.now());
      cleanProcessed();
      return { status: "declined" as const, reason: "handler_declined", jobId, agentKey };
    }
    await reportProgress(
      jobId,
      "finalizing",
      result.metadata?.fix && (result.metadata.fix as { status?: string }).status === "pull_request"
        ? `${name} opened a pull request with the fixes. Submitting the review.`
        : result.evidence?.length
          ? `Submitting the deliverable with ${result.evidence.length} source link${result.evidence.length === 1 ? "" : "s"} for your review.`
          : "Submitting the deliverable for your review.",
      90,
    );
    const signingKey = configuredAgent.signingKey;
    await submitDeliverable(
      jobId,
      result.deliverable,
      result.evidence ?? [],
      result.watch,
      signingKey ? signDeliverable(signingKey, jobId, result.deliverable) : undefined,
    );
    // A GitHub-triggered review is also posted on its pull request. Best effort: the delivery in
    // Liege is what the client pays for.
    const github = githubPolicy(policy);
    if (github?.postComment && config.marcusGithubToken)
      await postReviewComment({
        token: config.marcusGithubToken,
        github,
        agentName: name,
        deliverable: result.deliverable,
      }).catch((error) =>
        console.warn(
          JSON.stringify({
            event: "github.comment_failed",
            jobId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    await completeEvent(eventId, configuredAgent.id);
    processed.set(eventId, Date.now());
    cleanProcessed();
    return { status: "submitted" as const, jobId, agentKey, metadata: result.metadata ?? {} };
  } finally {
    running.delete(jobId);
  }
}

/** Answers an invitation to bid once, before bidding closes. */
async function bid(agentKey: AgentKey, eventId: string, event: LiegeWebhook) {
  const bidId = event.bidId;
  if (!bidId) throw new Error("Bid request has no bidId.");
  if (processed.has(eventId)) return { status: "ignored" as const, reason: "duplicate" };
  const agentId = config.agents[agentKey].id;
  const invitation = await getBid(bidId);
  if (!invitation.open || invitation.status !== "invited")
    return { status: "ignored" as const, reason: "bidding_closed" };
  const receipt = await claimEvent(eventId, agentId);
  if (!receipt.claimed) return { status: "ignored" as const, reason: "durable_duplicate" };
  const answer = await prepareBid(agentKey, invitation);
  await submitBid(bidId, answer);
  await completeEvent(eventId, agentId);
  processed.set(eventId, Date.now());
  cleanProcessed();
  return {
    status: "decline" in answer ? ("declined" as const) : ("bid" as const),
    bidId,
    agentKey,
    ...("decline" in answer ? {} : { price: answer.price }),
  };
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });

export const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    console.log(
      JSON.stringify({
        event: "http.request",
        requestId,
        method: request.method,
        route: url.pathname,
      }),
    );
    if (request.method === "GET" && url.pathname === "/health")
      return json(200, {
        status: "ok",
        service: "superagents-agents",
        commit: process.env.GIT_SHA ?? null,
        agents: Object.keys(config.agents),
        walletAuthority: false,
      });
    if (request.method !== "POST" || !url.pathname.startsWith("/webhooks/"))
      return json(404, { code: "not_found" });
    const agentKey = agentForPath(url.pathname);
    if (!agentKey) return json(404, { code: "agent_not_found" });
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 1_000_000) return json(413, { code: "payload_too_large" });
    const body = await request.text();
    if (!verify(body, request.headers.get("x-liege-signature"), config.agents[agentKey].secret))
      return json(401, { code: "invalid_signature" });
    const eventId = request.headers.get("x-liege-event-id");
    if (!eventId) return json(400, { code: "event_id_required" });
    let event: LiegeWebhook;
    try {
      event = JSON.parse(body) as LiegeWebhook;
    } catch {
      return json(400, { code: "invalid_json" });
    }
    if (event.type === "superagent.connection_test") {
      const probe = event as unknown as { agentId: string; challenge: string; serviceSlug: string };
      if (
        probe.agentId !== config.agents[agentKey].id ||
        !/^[a-f0-9]{64}$/.test(probe.challenge || "")
      )
        return json(400, { code: "invalid_connection_test" });
      if (!handlers[agentKey].serviceSlugs.includes(probe.serviceSlug))
        return json(422, { code: "unknown_service" });
      const proof = createHmac("sha256", config.agents[agentKey].secret)
        .update(`superagent.connection_test:${probe.agentId}:${probe.challenge}`)
        .digest("hex");
      return new Response(null, { status: 204, headers: { "x-liege-connection-proof": proof } });
    }
    if (event.type === "superagent.call") {
      try {
        const reply = await answerCall(config.agents[agentKey], handlers[agentKey], event);
        return new Response(JSON.stringify({ data: reply.data }), {
          status: reply.status,
          headers: { "content-type": "application/json", ...reply.headers },
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            eventId,
            agentKey,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return json(500, { code: "call_failed" });
      }
    }
    if (event.type === "auction.bid_requested") {
      try {
        return json(200, await bid(agentKey, eventId, event));
      } catch (error) {
        console.error(
          JSON.stringify({
            eventId,
            agentKey,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return json(500, { code: "bid_failed" });
      }
    }
    // A revision request returns the job to funded; the agent revises with the client's feedback.
    if (event.type !== "job.funded" && event.type !== "job.revision_requested")
      return json(202, { status: "ignored", reason: event.type ?? "unknown_event" });
    try {
      return json(200, await execute(agentKey, eventId, event));
    } catch (error) {
      console.error(
        JSON.stringify({
          eventId,
          agentKey,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json(500, { code: "execution_failed" });
    }
  },
});

console.log(`Super Agents runtime listening on :${server.port}`);

// Publish each signing key so signed deliveries verify. Best effort: a failure is logged, and the
// agent's next signed delivery is refused until the key is published.
for (const agent of Object.values(config.agents))
  if (agent.signingKey)
    void publishSigningKey(agent.id, agent.signingKey.publicKey)
      .then((published) =>
        console.log(
          JSON.stringify({ event: "signing.key_published", agent: agent.key, ...published }),
        ),
      )
      .catch((error) =>
        console.warn(
          JSON.stringify({
            event: "signing.key_publish_failed",
            agent: agent.key,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
