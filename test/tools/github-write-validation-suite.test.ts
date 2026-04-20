import { describe, expect, it, vi } from "vitest";
import {
  buildGithubWriteSmokePlan,
  createGithubWriteValidationSuiteResult,
} from "../../src/tools/github-write-validation-suite.js";
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
  it("skips unless explicitly enabled", async () => {
    await expect(createGithubWriteValidationSuiteResult({ env: {} })).resolves.toEqual({
      status: "skipped",
      reason: "Set MOTTBOT_GITHUB_WRITE_SMOKE_ENABLED=true to validate live GitHub writes.",
    });
  });

  it("returns a dry-run plan without requiring confirmation", async () => {
    const result = await createGithubWriteValidationSuiteResult({
      env: {
        MOTTBOT_GITHUB_WRITE_SMOKE_ENABLED: "true",
        MOTTBOT_GITHUB_WRITE_SMOKE_DRY_RUN: "true",
        MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY: "espresso95/mottbot-smoke",
        MOTTBOT_GITHUB_WRITE_SMOKE_PR_NUMBER: "7",
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
      env: {
        MOTTBOT_GITHUB_WRITE_SMOKE_ENABLED: "true",
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      issues: [
        "MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY is required.",
        "MOTTBOT_GITHUB_WRITE_SMOKE_CONFIRM must equal create-live-github-issue.",
      ],
    });
  });

  it("parses labels and pull request numbers from environment", () => {
    expect(
      buildGithubWriteSmokePlan({
        MOTTBOT_GITHUB_WRITE_SMOKE_ENABLED: "true",
        MOTTBOT_GITHUB_WRITE_SMOKE_DRY_RUN: "true",
        MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY: "espresso95/mottbot-smoke",
        MOTTBOT_GITHUB_WRITE_SMOKE_LABELS: "smoke, smoke ,bot",
        MOTTBOT_GITHUB_WRITE_SMOKE_PR_NUMBER: "7",
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
      env: {
        MOTTBOT_GITHUB_WRITE_SMOKE_ENABLED: "true",
        MOTTBOT_GITHUB_WRITE_SMOKE_CONFIRM: "create-live-github-issue",
        MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY: "espresso95/mottbot-smoke",
        MOTTBOT_GITHUB_WRITE_SMOKE_TITLE: "Smoke issue",
        MOTTBOT_GITHUB_WRITE_SMOKE_BODY: "Smoke body",
        MOTTBOT_GITHUB_WRITE_SMOKE_LABELS: "smoke",
        MOTTBOT_GITHUB_WRITE_SMOKE_PR_NUMBER: "7",
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
