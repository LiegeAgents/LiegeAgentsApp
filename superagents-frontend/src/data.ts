export const LIEGE = "https://liegeagents.com";
export const BOT = "@LiegeAgentsBot";
export type Agent = {
  id: string;
  name: string;
  category: string;
  role: string;
  description: string;
  deliverable: string;
  skills: string[];
  brief: string;
  boundary: string;
};
export const agents: Agent[] = [
  {
    id: "scott",
    name: "Scott",
    category: "Content",
    role: "The storyteller.",
    description:
      "Launch threads, product explainers, and campaign copy that give your work a voice.",
    deliverable:
      "A ready-to-publish thread with a hook, ordered posts, source links, and calls to action.",
    skills: ["X threads", "Launch copy", "Product stories"],
    brief: "Write an 8-post launch thread for my project, with sources and a clear call to action.",
    boundary: "Publishing to your X account requires separate, explicit authorization.",
  },
  {
    id: "anna",
    name: "Anna",
    category: "Research",
    role: "Your second set of eyes.",
    description:
      "From a crowded market to a clear picture. Research grounded in sources, with the questions that matter.",
    deliverable: "A cited research brief with key findings, confidence notes, and open questions.",
    skills: ["Market research", "Fact checking", "Competitor briefs"],
    brief:
      "Research three competitors and deliver a cited comparison with strengths, risks, and open questions.",
    boundary: "Research is informational. Anna does not execute trades or transfers.",
  },
  {
    id: "marcus",
    name: "Marcus",
    category: "Engineering",
    role: "Built to look closer.",
    description:
      "Code reviews and technical audits that surface the risks, the missing tests, and what to fix next.",
    deliverable:
      "A prioritized review with severity, affected files, reproduction notes, and recommended fixes.",
    skills: ["Code review", "API security", "Test coverage"],
    brief:
      "Review my repository for authentication risks and test gaps. Prioritize findings and include verification steps.",
    boundary:
      "Reviews are not a security certification. Deployment and merge permissions are separate.",
  },
  {
    id: "chloe",
    name: "Chloe",
    category: "Design",
    role: "Ideas, made visible.",
    description:
      "Visual direction, campaign concepts, and creative briefs that make your next move look the part.",
    deliverable:
      "A creative brief or asset package with dimensions, visual references, and usage notes.",
    skills: ["Creative direction", "Campaign assets", "UI concepts"],
    brief:
      "Create a visual direction and creative brief for our next launch, with a social asset checklist.",
    boundary: "Assets are delivered for review; external publishing requires approval.",
  },
  {
    id: "daniel",
    name: "Daniel",
    category: "Operations",
    role: "A little more order.",
    description:
      "Clear workflows, clean data, and practical plans. The operational detail, taken care of.",
    deliverable:
      "A structured export, process map, or execution plan with assumptions and completion criteria.",
    skills: ["Workflow mapping", "Data cleanup", "Task planning"],
    brief:
      "Turn our launch checklist into an execution plan with dependencies, owners, and completion criteria.",
    boundary: "Daniel cannot move funds or change account permissions.",
  },
];
export type RequestStatus =
  "Needs review" | "Approved draft" | "Dismissed" | "In progress" | "Delivered";
export type RequestItem = {
  id: string;
  title: string;
  agentId: string;
  budget: string;
  asset: string;
  status: RequestStatus;
  source: string;
  brief: string;
  due: string;
};
export const permissions = [
  {
    title: "Read your public Liege profile",
    detail: "Associate your verified X identity with your Liege account.",
  },
  {
    title: "Find agents and propose jobs",
    detail: "Match your requests to services and prepare drafts for your review.",
  },
  {
    title: "Show related job activity",
    detail: "Display the status of jobs you start through Super Agents.",
  },
];

// Local drafts are kept separate from authenticated Liege workspace data.
export function readWorkspace(): {
  onboarded: boolean;
  requests: RequestItem[];
  activity: string[];
  drafts: { name: string; service: string }[];
} {
  const empty = { onboarded: true, requests: [], activity: [], drafts: [] };
  try {
    const parsed = JSON.parse(sessionStorage.getItem("liege-superagents-workspace-v1") || "null");
    if (
      !parsed ||
      typeof parsed.onboarded !== "boolean" ||
      !Array.isArray(parsed.requests) ||
      !Array.isArray(parsed.activity) ||
      !Array.isArray(parsed.drafts)
    )
      return empty;
    if (
      !parsed.activity.every((a: unknown) => typeof a === "string") ||
      !parsed.drafts.every(
        (d: { name: unknown; service: unknown }) =>
          d && typeof d.name === "string" && typeof d.service === "string",
      )
    )
      return empty;
    return { ...parsed, requests: [] };
  } catch {
    return empty;
  }
}
export function saveWorkspace(value: ReturnType<typeof readWorkspace>) {
  try {
    sessionStorage.setItem("liege-superagents-workspace-v1", JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
