import { createHash, createHmac } from "node:crypto";
import type { LiegeWebhook, SuperAgentHandler } from "./types.js";

/** The proof Liege checks before paying for an answer: bound to the call and the exact output. */
export const callProof = (secret: string, callId: string, output: string) =>
  createHmac("sha256", secret)
    .update(`superagent.call:${callId}:${createHash("sha256").update(output).digest("hex")}`)
    .digest("hex");

/**
 * Answers an instant call while Liege waits. Liege pays the owner only for an answer that carries
 * the call proof; a decline or any other reply is refunded to the client.
 */
export async function answerCall(
  agent: { id: string; secret: string },
  handler: SuperAgentHandler,
  event: LiegeWebhook,
): Promise<{ status: number; data: Record<string, unknown>; headers: Record<string, string> }> {
  const call = event;
  if (call.agentId !== agent.id || !call.callId || typeof call.input !== "string")
    return { status: 400, data: { code: "invalid_call" }, headers: {} };
  if (!call.serviceSlug || !handler.serviceSlugs.includes(call.serviceSlug))
    return { status: 422, data: { code: "unknown_service" }, headers: {} };
  const result = await handler.execute({
    jobId: call.callId,
    brief: call.input,
    requirements: { serviceSlug: call.serviceSlug, instantCall: true },
  });
  if (result.decline)
    return { status: 200, data: { status: "declined", reason: result.decline }, headers: {} };
  return {
    status: 200,
    data: { status: "answered", output: result.deliverable },
    headers: { "x-liege-call-proof": callProof(agent.secret, call.callId, result.deliverable) },
  };
}
