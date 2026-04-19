import type { ToolHandler } from "./executor.js";
import type { GithubReadOperations } from "./github-read.js";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export function createGithubToolHandlers(github: GithubReadOperations): Partial<Record<string, ToolHandler>> {
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
  };
}
