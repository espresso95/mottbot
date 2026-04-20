import { describe, expect, it, vi } from "vitest";
import { createGithubToolHandlers } from "../../src/tools/github-handlers.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { GithubReadOperations, GithubWriteOperations } from "../../src/tools/github-read.js";

const definition: ToolDefinition = {
  name: "test_tool",
  description: "Test tool.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
  sideEffect: "read_only",
  enabled: true,
};

describe("GitHub tool handlers", () => {
  it("routes model tool calls to GitHub read operations", async () => {
    const github: GithubReadOperations & GithubWriteOperations = {
      repository: vi.fn(async () => ({
        repository: "espresso95/mottbot",
        url: "https://github.com/espresso95/mottbot",
        description: "",
        isPrivate: false,
        isArchived: false,
        isFork: false,
      })),
      openPullRequests: vi.fn(async () => ({ repository: "espresso95/mottbot", pullRequests: [], truncated: false })),
      recentIssues: vi.fn(async () => ({ repository: "espresso95/mottbot", issues: [], truncated: false })),
      ciStatus: vi.fn(async () => ({ repository: "espresso95/mottbot", runs: [], truncated: false })),
      recentWorkflowFailures: vi.fn(async () => ({ repository: "espresso95/mottbot", runs: [], truncated: false })),
      createIssue: vi.fn(async () => ({
        ok: true,
        action: "created_issue",
        repository: "espresso95/mottbot",
        title: "title",
        labels: [],
      })),
      commentOnIssue: vi.fn(async () => ({
        ok: true,
        action: "commented_issue",
        repository: "espresso95/mottbot",
        number: 1,
      })),
      commentOnPullRequest: vi.fn(async () => ({
        ok: true,
        action: "commented_pull_request",
        repository: "espresso95/mottbot",
        number: 2,
      })),
    };
    const handlers = createGithubToolHandlers(github);

    await handlers.mottbot_github_repo!({ definition, arguments: { repository: "espresso95/mottbot" } });
    await handlers.mottbot_github_open_prs!({ definition, arguments: { limit: 2 } });
    await handlers.mottbot_github_recent_issues!({ definition, arguments: { limit: 3 } });
    await handlers.mottbot_github_ci_status!({ definition, arguments: { limit: 4 } });
    await handlers.mottbot_github_workflow_failures!({ definition, arguments: { limit: 5 } });

    expect(github.repository).toHaveBeenCalledWith({ repository: "espresso95/mottbot" });
    expect(github.openPullRequests).toHaveBeenCalledWith({ repository: undefined, limit: 2 });
    expect(github.recentIssues).toHaveBeenCalledWith({ repository: undefined, limit: 3 });
    expect(github.ciStatus).toHaveBeenCalledWith({ repository: undefined, limit: 4 });
    expect(github.recentWorkflowFailures).toHaveBeenCalledWith({ repository: undefined, limit: 5 });
  });

  it("routes model tool calls to GitHub write operations", async () => {
    const github: GithubReadOperations & GithubWriteOperations = {
      repository: vi.fn(),
      openPullRequests: vi.fn(),
      recentIssues: vi.fn(),
      ciStatus: vi.fn(),
      recentWorkflowFailures: vi.fn(),
      createIssue: vi.fn(async () => ({
        ok: true,
        action: "created_issue",
        repository: "espresso95/mottbot",
        title: "New issue",
        labels: ["bug"],
      })),
      commentOnIssue: vi.fn(async () => ({
        ok: true,
        action: "commented_issue",
        repository: "espresso95/mottbot",
        number: 11,
      })),
      commentOnPullRequest: vi.fn(async () => ({
        ok: true,
        action: "commented_pull_request",
        repository: "espresso95/mottbot",
        number: 12,
      })),
    };
    const handlers = createGithubToolHandlers(github);

    await handlers.mottbot_github_issue_create!({
      definition,
      arguments: {
        repository: "espresso95/mottbot",
        title: "New issue",
        body: "Issue body",
        labels: ["bug"],
      },
    });
    await handlers.mottbot_github_issue_comment!({
      definition,
      arguments: {
        number: 11,
        body: "Issue comment",
      },
    });
    await handlers.mottbot_github_pr_comment!({
      definition,
      arguments: {
        number: 12,
        body: "PR comment",
      },
    });

    expect(github.createIssue).toHaveBeenCalledWith({
      repository: "espresso95/mottbot",
      title: "New issue",
      body: "Issue body",
      labels: ["bug"],
    });
    expect(github.commentOnIssue).toHaveBeenCalledWith({
      repository: undefined,
      number: 11,
      body: "Issue comment",
    });
    expect(github.commentOnPullRequest).toHaveBeenCalledWith({
      repository: undefined,
      number: 12,
      body: "PR comment",
    });
  });
});
