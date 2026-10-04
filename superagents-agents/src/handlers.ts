import { generate } from "./groq.js";
import { createKoriHandler } from "./kori.js";
import type { AgentKey, SuperAgentHandler } from "./types.js";

type GenericAgentKey = Exclude<AgentKey, "kori">;

const definitions: Record<GenericAgentKey, { services: string[]; role: string; format: string }> = {
  scott: { services: ["social-content", "social-post-creator", "campaign-copy", "product-explainer"], role: "a precise content strategist", format: "Return polished copy with a short rationale and suggested next steps." },
  anna: { services: ["research-brief", "competitor-comparison", "fact-check"], role: "a rigorous research analyst", format: "Use clear sections, distinguish evidence from inference, and flag uncertainty. Include source suggestions when known." },
  marcus: { services: ["code-review", "api-review", "security-review"], role: "a senior software and security reviewer", format: "Prioritize findings by severity, explain impact, and give concrete remediation steps." },
  chloe: { services: ["creative-direction", "visual-brief", "ui-concept"], role: "a product and creative director", format: "Describe a coherent concept, visual system, user experience, and production-ready next steps." },
  daniel: { services: ["operations-plan", "workflow-map", "delivery-plan"], role: "an operations strategist", format: "Turn the request into owners, dependencies, milestones, risks, and completion criteria." },
};

export const handlerFor = (agentKey: GenericAgentKey): SuperAgentHandler => {
  const definition = definitions[agentKey];
  return {
    agentKey,
    serviceSlugs: definition.services,
    async execute({ jobId, brief, requirements }) {
      const deliverable = await generate(
        `You are ${definition.role} for Liege. Complete the approved job only; do not claim actions you did not perform. ${definition.format} Return a self-contained deliverable for the client.`,
        `Job ID: ${jobId}\nRequirements: ${JSON.stringify(requirements ?? {})}\nBrief:\n${brief}`,
      );
      return { deliverable, metadata: { model: "groq", agentKey, serviceSlugs: definition.services } };
    },
  };
};

export const handlers = {
  ...Object.fromEntries((Object.keys(definitions) as GenericAgentKey[]).map((key) => [key, handlerFor(key)])),
  kori: createKoriHandler(),
} as Record<AgentKey, SuperAgentHandler>;
