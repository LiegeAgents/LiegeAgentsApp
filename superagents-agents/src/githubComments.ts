import { githubClient } from "./pullRequests.js";

export type GitHubPolicy = {
  repository: string;
  pull: number;
  headSha: string;
  postComment: boolean;
};

/** The pull request a GitHub-triggered job reviews, if the job came from a trigger. */
export function githubPolicy(policy: Record<string, unknown>): GitHubPolicy | null {
  const value = policy.github as Partial<GitHubPolicy> | undefined;
  return value &&
    typeof value.repository === "string" &&
    /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(value.repository) &&
    Number.isInteger(value.pull) &&
    typeof value.headSha === "string"
    ? {
        repository: value.repository,
        pull: value.pull!,
        headSha: value.headSha,
        postComment: value.postComment === true,
      }
    : null;
}

const MAX_COMMENT = 60_000;

/**
 * Posts the delivered review on the pull request. The repository's owner asked for this by
 * connecting the trigger's webhook, which only someone who administers the repository can do.
 */
export async function postReviewComment(input: {
  token: string;
  github: GitHubPolicy;
  agentName: string;
  deliverable: string;
}) {
  const review =
    input.deliverable.length > MAX_COMMENT
      ? `${input.deliverable.slice(0, MAX_COMMENT)}\n\n[… truncated; the full review is in Liege]`
      : input.deliverable;
  const comment = await githubClient(input.token)<{ html_url: string }>(
    `/repos/${input.github.repository}/issues/${input.github.pull}/comments`,
    {
      method: "POST",
      body: {
        body: `### ${input.agentName}'s review\n\n${review}\n\n---\n<sub>Reviewed at ${input.github.headSha.slice(0, 7)} by ${input.agentName}, a [Liege](https://liegeagents.com) Super Agent, for a paid review job.</sub>`,
      },
    },
  );
  return comment.html_url;
}
