import { createHash } from "node:crypto";

export type EvaluationCriterion = { id: string; prompt: string; weight: number; maxScore: number };

export const decisionMessage = (input: {
  taskId: string;
  outcome: "accepted" | "rejected";
  scores: Record<string, number>;
  rationaleHash: string;
  evidence: string[];
}) => {
  const canonical = JSON.stringify({
    taskId: input.taskId,
    outcome: input.outcome,
    scores: Object.fromEntries(Object.entries(input.scores).sort(([a], [b]) => a.localeCompare(b))),
    rationaleHash: input.rationaleHash,
    evidence: [...input.evidence].sort(),
  });
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `Liege evaluation decision\nTask: ${input.taskId}\nDigest: ${digest}`;
};
