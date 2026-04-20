import type { ToolHandler } from "./executor.js";
import type { GithubReadOperations, GithubWriteOperations } from "./github-read.js";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

export function createGithubToolHandlers(
  github: GithubReadOperations & GithubWriteOperations,
): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_github_repo: ({ arguments: input }) =>
      github.repository({
        repository: optionalString(input.repository),
      }),
    mottbot_github_open_prs: ({ arguments: input }) =>
      github.openPullRequests({
        repository: optionalString(input.repository),
        limit: optionalInteger(input.limit),
      }),
    mottbot_github_recent_issues: ({ arguments: input }) =>
      github.recentIssues({
        repository: optionalString(input.repository),
        limit: optionalInteger(input.limit),
      }),
    mottbot_github_ci_status: ({ arguments: input }) =>
      github.ciStatus({
        repository: optionalString(input.repository),
        limit: optionalInteger(input.limit),
      }),
    mottbot_github_workflow_failures: ({ arguments: input }) =>
      github.recentWorkflowFailures({
        repository: optionalString(input.repository),
        limit: optionalInteger(input.limit),
      }),
    mottbot_github_issue_create: ({ arguments: input }) =>
      github.createIssue({
        repository: optionalString(input.repository),
        title: optionalString(input.title) ?? "",
        body: typeof input.body === "string" ? input.body : undefined,
        labels: stringArray(input.labels),
      }),
    mottbot_github_issue_comment: ({ arguments: input }) =>
      github.commentOnIssue({
        repository: optionalString(input.repository),
        number: optionalInteger(input.number) ?? 0,
        body: typeof input.body === "string" ? input.body : "",
      }),
    mottbot_github_pr_comment: ({ arguments: input }) =>
      github.commentOnPullRequest({
        repository: optionalString(input.repository),
        number: optionalInteger(input.number) ?? 0,
        body: typeof input.body === "string" ? input.body : "",
      }),
  };
}
