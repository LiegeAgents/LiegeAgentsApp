import { describe, expect, test } from "bun:test";
import { answerCall, callProof } from "./calls.js";
import type { SuperAgentHandler } from "./types.js";

const agent = { id: "constantine-agent", secret: "constantine-secret" };

function handler(result: { deliverable: string; decline?: string }) {
  const seen: unknown[] = [];
  const value: SuperAgentHandler = {
    agentKey: "constantine",
    serviceSlugs: ["rug-check"],
    async execute(input) {
      seen.push(input);
      return result;
    },
  };
  return { value, seen };
}

const event = {
  type: "superagent.call",
  callId: "call-1",
  agentId: agent.id,
  serviceSlug: "rug-check",
  input: "Check 0xabc",
};

describe("instant calls", () => {
  test("an answer carries the proof bound to the call and the exact output", async () => {
    const { value, seen } = handler({ deliverable: "# Rug check\nNo major red flags." });
    const reply = await answerCall(agent, value, event);
    expect(reply).toMatchObject({
      status: 200,
      data: { status: "answered", output: "# Rug check\nNo major red flags." },
    });
    expect(reply.headers["x-liege-call-proof"]).toBe(
      callProof(agent.secret, "call-1", "# Rug check\nNo major red flags."),
    );
    expect(reply.headers["x-liege-call-proof"]).not.toBe(
      callProof(agent.secret, "call-2", "# Rug check\nNo major red flags."),
    );
    expect(seen[0]).toMatchObject({
      jobId: "call-1",
      brief: "Check 0xabc",
      requirements: { serviceSlug: "rug-check", instantCall: true },
    });
  });

  test("a decline is passed on without a proof, so Liege refunds it", async () => {
    const { value } = handler({ deliverable: "", decline: "No token address in the request." });
    expect(await answerCall(agent, value, event)).toEqual({
      status: 200,
      data: { status: "declined", reason: "No token address in the request." },
      headers: {},
    });
  });

  test("calls for another agent or an unknown service are refused before any work", async () => {
    const { value, seen } = handler({ deliverable: "x" });
    expect((await answerCall(agent, value, { ...event, agentId: "someone-else" })).status).toBe(
      400,
    );
    expect((await answerCall(agent, value, { ...event, serviceSlug: "pitch-deck" })).status).toBe(
      422,
    );
    expect(seen).toHaveLength(0);
  });
});
