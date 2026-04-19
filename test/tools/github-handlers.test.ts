import { describe, expect, it, vi } from "vitest";
import { createGithubToolHandlers } from "../../src/tools/github-handlers.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { GithubReadOperations } from "../../src/tools/github-read.js";

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
    const github: GithubReadOperations = {
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
});
