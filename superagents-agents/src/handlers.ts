import { config } from "./config.js";
import { generate } from "./groq.js";
import { proposeFixes, type FixResult } from "./pullRequests.js";
import { createKoriHandler, koriServiceSlugs } from "./kori.js";
import { constantineServiceSlugs, createConstantineHandler } from "./constantine.js";
import { revisionPrompt } from "./types.js";
import type { AgentKey, SuperAgentHandler } from "./types.js";
import type { PreparedAttachments } from "./attachments.js";

type GenericAgentKey = Exclude<AgentKey, "kori" | "constantine">;

const urlPattern = /https:\/\/[^\s<>"')\]]+/gi;

/** Extract safe HTTPS sources supplied by the requester for Anna's evidence trail. */
export function extractEvidenceUrls(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const urls = text.match(urlPattern) ?? [];
  return [
    ...new Set(
      urls
        .map((url) => url.replace(/[.,;:!?]+$/, ""))
        .filter((url) => {
          try {
            const parsed = new URL(url);
            return (
              parsed.protocol === "https:" &&
              !parsed.username &&
              !parsed.password &&
              url.length <= 2048
            );
          } catch {
            return false;
          }
        }),
    ),
  ].slice(0, 20);
}

const definitions: Record<GenericAgentKey, { services: string[]; role: string; format: string }> = {
  scott: {
    services: ["social-content", "social-post-creator", "campaign-copy", "product-explainer"],
    role: "a precise content strategist",
    format: "Return polished copy with a short rationale and suggested next steps.",
  },
  anna: {
    services: ["research-brief", "competitor-comparison", "fact-check"],
    role: "a rigorous research analyst",
    format:
      "Use clear sections, distinguish evidence from inference, and flag uncertainty. Include source suggestions when known.",
  },
  marcus: {
    services: ["code-review", "api-review", "security-review"],
    role: "a senior software and security reviewer",
    format: "Prioritize findings by severity, explain impact, and give concrete remediation steps.",
  },
  chloe: {
    services: ["creative-direction", "visual-brief", "ui-concept"],
    role: "a product and creative director",
    format:
      "Describe a coherent concept, visual system, user experience, and production-ready next steps.",
  },
  daniel: {
    services: ["operations-plan", "workflow-map", "delivery-plan"],
    role: "an operations strategist",
    format:
      "Turn the request into owners, dependencies, milestones, risks, and completion criteria.",
  },
};

/**
 * Marcus turns his review of an attached repository into a pull request. Publishing is best
 * effort: a failure is reported in the deliverable and never fails the review itself.
 */
async function fixRepository(
  jobId: string,
  review: string,
  attachments: PreparedAttachments | undefined,
  report: ((stage: "reviewing", message: string, percent: number) => Promise<void>) | undefined,
): Promise<FixResult | { status: "failed"; reason: string } | null> {
  const snapshot = attachments?.repositories?.find((repository) => repository.files.length);
  if (!snapshot || !config.marcusGithubToken) return null;
  await report?.("reviewing", "Marcus is writing fixes and checking that they parse.", 70);
  try {
    return await proposeFixes({ jobId, review, snapshot, token: config.marcusGithubToken });
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "fix.failed",
        jobId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      status: "failed",
      reason:
        "Marcus could not prepare a pull request this time; the review above stands on its own.",
    };
  }
}

const fixSection = (fix: FixResult | { status: "failed"; reason: string }) => {
  if ("url" in fix)
    return `\n\n## Fixes\n${
      fix.status === "pull_request"
        ? `I opened a pull request with these fixes: ${fix.url}`
        : `The fixes are ready on a branch. Open the pull request in one click: ${fix.url}`
    }\n${fix.edits.map((edit) => `- ${edit.path}: ${edit.reason || "see the diff"}`).join("\n")}\n\nEvery changed file was parsed before committing (${fix.checked} file${fix.checked === 1 ? "" : "s"}); your tests were not run, so run them before merging.${
      fix.skipped.length ? `\nNot applied: ${fix.skipped.join(" ")}` : ""
    }`;
  return `\n\n## Fixes\n${fix.reason}${"skipped" in fix && fix.skipped.length ? ` ${fix.skipped.join(" ")}` : ""}`;
};

export const handlerFor = (agentKey: GenericAgentKey): SuperAgentHandler => {
  const definition = definitions[agentKey];
  return {
    agentKey,
    serviceSlugs: definition.services,
    async execute({ jobId, brief, requirements, revision, attachments, report }) {
      let deliverable = await generate(
        `You are ${definition.role} for Liege. Complete the approved job only; do not claim actions you did not perform. ${definition.format} Return a self-contained deliverable for the client.${agentKey === "anna" ? " Cite only HTTPS sources supplied in the brief, requirements, or attachments, and label unsupported claims as inference." : ""}`,
        `Job ID: ${jobId}\nRequirements: ${JSON.stringify(requirements ?? {})}\nBrief:\n${brief}${attachments?.text ?? ""}${revision ? revisionPrompt(revision) : ""}`,
        attachments?.images,
      );
      const fix =
        agentKey === "marcus" ? await fixRepository(jobId, deliverable, attachments, report) : null;
      if (fix) deliverable += fixSection(fix);
      // Pinned repository snapshots the agent actually read are proof of what it reviewed.
      const snapshots = (attachments?.evidence ?? []).filter((url) =>
        /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[0-9a-f]{40}$/.test(url),
      );
      return {
        deliverable,
        ...(agentKey === "anna"
          ? {
              // Only client-supplied sources count; never links from a generated first draft.
              evidence: [
                ...new Set([
                  ...extractEvidenceUrls(
                    `${brief}\n${JSON.stringify(requirements ?? {})}\n${revision?.feedback ?? ""}`,
                  ),
                  ...(attachments?.evidence ?? []),
                ]),
              ].slice(0, 20),
            }
          : snapshots.length || (fix && "url" in fix)
            ? {
                evidence: [...(fix && "url" in fix ? [fix.url] : []), ...snapshots].slice(0, 20),
              }
            : {}),
        metadata: {
          model: "groq",
          agentKey,
          serviceSlugs: definition.services,
          ...(attachments ? { attachmentNotes: attachments.notes } : {}),
          ...(fix
            ? { fix: { status: fix.status, ...("url" in fix ? { url: fix.url } : {}) } }
            : {}),
        },
      };
    },
  };
};

export const handlers = {
  ...Object.fromEntries(
    (Object.keys(definitions) as GenericAgentKey[]).map((key) => [key, handlerFor(key)]),
  ),
  kori: createKoriHandler(),
  constantine: createConstantineHandler(),
} as Record<AgentKey, SuperAgentHandler>;

/** How an agent describes itself when it bids: its role and the services it offers. */
export const profileFor = (
  agentKey: AgentKey,
): { role: string; services: string[]; promise?: string } =>
  agentKey === "kori"
    ? { role: "a customer support specialist", services: koriServiceSlugs }
    : agentKey === "constantine"
      ? {
          role: "a token risk analyst who checks a token's live contract, holder, and liquidity data for rug-pull risk",
          services: constantineServiceSlugs,
          promise:
            "Promise only a written rug-check report built from the token's live contract, holder, and liquidity data; never promise audits, price calls, or other actions.",
        }
      : { role: definitions[agentKey].role, services: definitions[agentKey].services };
