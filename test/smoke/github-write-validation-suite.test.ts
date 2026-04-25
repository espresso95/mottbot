import { describe, expect, it, vi } from "vitest";
import {
  buildGithubWriteSmokePlan,
  createGithubWriteValidationSuiteResult,
} from "../../scripts/smoke/github-write-validation-suite.js";
import type { GithubReadOperations, GithubWriteOperations } from "../../src/tools/github-read.js";

function createGithub(): GithubReadOperations & GithubWriteOperations {
  return {
    repository: vi.fn(),
    openPullRequests: vi.fn(),
    recentIssues: vi.fn(),
    ciStatus: vi.fn(),
    recentWorkflowFailures: vi.fn(),
    createIssue: vi.fn(async () => ({
      ok: true,
      action: "created_issue",
      repository: "espresso95/mottbot-smoke",
      number: 42,
      title: "Smoke issue",
      url: "https://github.com/espresso95/mottbot-smoke/issues/42",
      labels: ["smoke"],
    })),
    commentOnIssue: vi.fn(async () => ({
      ok: true,
      action: "commented_issue",
      repository: "espresso95/mottbot-smoke",
      number: 42,
      url: "https://github.com/espresso95/mottbot-smoke/issues/42#issuecomment-1",
    })),
    commentOnPullRequest: vi.fn(async () => ({
      ok: true,
      action: "commented_pull_request",
      repository: "espresso95/mottbot-smoke",
      number: 7,
      url: "https://github.com/espresso95/mottbot-smoke/pull/7#issuecomment-2",
    })),
  };
}

describe("GitHub write validation suite", () => {
  it("returns a dry-run plan with repository when no enable flag is set", async () => {
    await expect(
      createGithubWriteValidationSuiteResult({
        options: { repository: "espresso95/mottbot-smoke" },
      }),
    ).resolves.toMatchObject({
      status: "dry-run",
      issues: [],
    });
  });

  it("returns a dry-run plan without requiring confirmation", async () => {
    const result = await createGithubWriteValidationSuiteResult({
      options: {
        dryRun: true,
        repository: "espresso95/mottbot-smoke",
        prNumber: 7,
      },
    });

    expect(result).toEqual({
      status: "dry-run",
      issues: [],
      plan: [
        {
          name: "create disposable GitHub issue",
          toolName: "mottbot_github_issue_create",
          repository: "espresso95/mottbot-smoke",
        },
        {
          name: "comment on created GitHub issue",
          toolName: "mottbot_github_issue_comment",
          repository: "espresso95/mottbot-smoke",
        },
        {
          name: "comment on configured GitHub pull request",
          toolName: "mottbot_github_pr_comment",
          repository: "espresso95/mottbot-smoke",
        },
      ],
    });
  });

  it("blocks live writes without repository and confirmation", async () => {
    const result = await createGithubWriteValidationSuiteResult({
      options: { dryRun: false },
    });

    expect(result).toMatchObject({
      status: "blocked",
      issues: ["--repository is required.", "--confirm must equal create-live-github-issue."],
    });
  });

  it("parses labels and pull request numbers from CLI options", () => {
    expect(
      buildGithubWriteSmokePlan({
        dryRun: true,
        repository: "espresso95/mottbot-smoke",
        labels: ["smoke", "smoke", "bot"],
        prNumber: 7,
      }),
    ).toMatchObject({
      labels: ["smoke", "bot"],
      prNumber: 7,
      issues: [],
    });
  });

  it("runs issue and pull request write scenarios through approvals", async () => {
    const github = createGithub();
    const result = await createGithubWriteValidationSuiteResult({
      options: {
        dryRun: false,
        confirm: "create-live-github-issue",
        repository: "espresso95/mottbot-smoke",
        title: "Smoke issue",
        body: "Smoke body",
        labels: ["smoke"],
        prNumber: 7,
      },
      github,
    });

    expect(result).toMatchObject({
      status: "passed",
      scenarios: [
        { name: "create disposable GitHub issue", status: "passed" },
        { name: "comment on created GitHub issue", status: "passed" },
        { name: "comment on configured GitHub pull request", status: "passed" },
      ],
    });
    expect(github.createIssue).toHaveBeenCalledWith({
      repository: "espresso95/mottbot-smoke",
      title: "Smoke issue",
      body: "Smoke body",
      labels: ["smoke"],
    });
    expect(github.commentOnIssue).toHaveBeenCalledWith({
      repository: "espresso95/mottbot-smoke",
      number: 42,
      body: "Mottbot GitHub write smoke comment.",
    });
    expect(github.commentOnPullRequest).toHaveBeenCalledWith({
      repository: "espresso95/mottbot-smoke",
      number: 7,
      body: "Mottbot GitHub write smoke PR comment.",
    });
  });
});
