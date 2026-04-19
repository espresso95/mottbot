import { describe, expect, it } from "vitest";
import {
  formatGithubIssues,
  formatGithubPullRequests,
  formatGithubStatusSummary,
  formatGithubWorkflowRuns,
  GithubCliReadService,
  parseGithubRemoteUrl,
  type GithubCommandRunner,
} from "../../src/tools/github-read.js";

function createRunner(): { runner: GithubCommandRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: GithubCommandRunner = async ({ command, args }) => {
    calls.push({ command, args });
    if (command === "git") {
      return { stdout: "git@github.com:espresso95/mottbot.git\n", stderr: "" };
    }
    if (args.includes("repo") && args.includes("view")) {
      return {
        stdout: JSON.stringify({
          nameWithOwner: "espresso95/mottbot",
          description: "repo description",
          isPrivate: false,
          isArchived: false,
          isFork: false,
          defaultBranchRef: { name: "main" },
          url: "https://github.com/espresso95/mottbot",
          pushedAt: "2026-04-19T00:00:00Z",
          viewerPermission: "WRITE",
        }),
        stderr: "",
      };
    }
    if (args.includes("pr") && args.includes("list")) {
      return {
        stdout: JSON.stringify([
          {
            number: 3,
            title: "Improve memory",
            author: { login: "octocat" },
            headRefName: "feature",
            baseRefName: "main",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            url: "https://github.com/espresso95/mottbot/pull/3",
            updatedAt: "2026-04-19T00:00:00Z",
          },
        ]),
        stderr: "",
      };
    }
    if (args.includes("issue") && args.includes("list")) {
      return {
        stdout: JSON.stringify([
          {
            number: 5,
            title: "Issue with Bearer test-token",
            author: { login: "octocat" },
            labels: [{ name: "bug" }],
            url: "https://github.com/espresso95/mottbot/issues/5",
            updatedAt: "2026-04-19T00:00:00Z",
          },
        ]),
        stderr: "",
      };
    }
    if (args.includes("run") && args.includes("list")) {
      return {
        stdout: JSON.stringify([
          {
            databaseId: 10,
            workflowName: "ci",
            displayTitle: "Build",
            status: "completed",
            conclusion: "failure",
            headBranch: "main",
            headSha: "abcdef123456",
            event: "push",
            url: "https://github.com/espresso95/mottbot/actions/runs/10",
            createdAt: "2026-04-19T00:00:00Z",
            updatedAt: "2026-04-19T00:00:00Z",
          },
        ]),
        stderr: "",
      };
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  return { runner, calls };
}

describe("GitHub read integration", () => {
  it("normalizes GitHub remote URLs without preserving credentials", () => {
    expect(parseGithubRemoteUrl("git@github.com:espresso95/mottbot.git")).toBe("espresso95/mottbot");
    expect(parseGithubRemoteUrl("https://github.com/espresso95/mottbot.git")).toBe("espresso95/mottbot");
    expect(parseGithubRemoteUrl("https://token@github.com/espresso95/mottbot")).toBe("espresso95/mottbot");
    expect(parseGithubRemoteUrl("ssh://git@github.com/espresso95/mottbot.git")).toBe("espresso95/mottbot");
    expect(parseGithubRemoteUrl("https://example.com/espresso95/mottbot.git")).toBeUndefined();
  });

  it("reads repository, pull requests, issues, and workflow runs through the configured runner", async () => {
    const { runner, calls } = createRunner();
    const github = new GithubCliReadService(
      {
        command: "gh",
        commandTimeoutMs: 10_000,
        maxItems: 5,
        maxOutputBytes: 80_000,
      },
      runner,
      "/repo",
    );

    await expect(github.repository()).resolves.toMatchObject({
      repository: "espresso95/mottbot",
      defaultBranch: "main",
    });
    await expect(github.openPullRequests({ limit: 2 })).resolves.toMatchObject({
      pullRequests: [expect.objectContaining({ number: 3, title: "Improve memory" })],
    });
    await expect(github.recentIssues()).resolves.toMatchObject({
      issues: [expect.objectContaining({ title: "Issue with [redacted]" })],
    });
    await expect(github.ciStatus()).resolves.toMatchObject({
      runs: [expect.objectContaining({ databaseId: 10, conclusion: "failure" })],
    });
    await expect(github.recentWorkflowFailures()).resolves.toMatchObject({
      runs: [expect.objectContaining({ databaseId: 10 })],
    });
    expect(calls[0]).toMatchObject({ command: "git", args: ["remote", "get-url", "origin"] });
    expect(calls.some((call) => call.command === "gh" && call.args.includes("repo"))).toBe(true);
  });

  it("rejects invalid repository identifiers before calling GitHub", async () => {
    const { runner } = createRunner();
    const github = new GithubCliReadService(
      {
        defaultRepository: "bad repo",
        command: "gh",
        commandTimeoutMs: 10_000,
        maxItems: 5,
        maxOutputBytes: 80_000,
      },
      runner,
      "/repo",
    );

    await expect(github.repository()).rejects.toThrow(/owner\/name/);
  });

  it("surfaces malformed CLI responses and missing repository config clearly", async () => {
    const malformed = new GithubCliReadService(
      {
        defaultRepository: "espresso95/mottbot",
        command: "gh",
        commandTimeoutMs: 10_000,
        maxItems: 5,
        maxOutputBytes: 80_000,
      },
      async () => ({ stdout: "{", stderr: "" }),
      "/repo",
    );
    await expect(malformed.repository()).rejects.toThrow(/malformed JSON/);

    const missingRepo = new GithubCliReadService(
      {
        command: "gh",
        commandTimeoutMs: 10_000,
        maxItems: 5,
        maxOutputBytes: 80_000,
      },
      async () => ({ stdout: "https://example.com/not/github.git\n", stderr: "" }),
      "/repo",
    );
    await expect(missingRepo.repository()).rejects.toThrow(/not configured/);
  });

  it("filters failed workflow runs and formats empty result sets", async () => {
    const github = new GithubCliReadService(
      {
        defaultRepository: "espresso95/mottbot",
        command: "gh",
        commandTimeoutMs: 10_000,
        maxItems: 2,
        maxOutputBytes: 80_000,
      },
      async ({ args }) => {
        if (args.includes("run")) {
          return {
            stdout: JSON.stringify([
              {
                databaseId: 11,
                workflowName: "ci",
                displayTitle: "Build ok",
                status: "completed",
                conclusion: "success",
                url: "https://github.com/espresso95/mottbot/actions/runs/11",
              },
            ]),
            stderr: "",
          };
        }
        return { stdout: "[]", stderr: "" };
      },
      "/repo",
    );

    await expect(github.recentWorkflowFailures()).resolves.toMatchObject({
      runs: [],
      truncated: false,
    });
    expect(formatGithubPullRequests("espresso95/mottbot", [])).toContain("none");
    expect(formatGithubIssues("espresso95/mottbot", [])).toContain("none");
    expect(
      formatGithubWorkflowRuns({
        repository: "espresso95/mottbot",
        title: "Recent failed workflow runs",
        runs: [],
      }),
    ).toContain("none");
  });

  it("formats a concise status summary", () => {
    expect(
      formatGithubStatusSummary({
        metadata: {
          repository: "espresso95/mottbot",
          url: "https://github.com/espresso95/mottbot",
          description: "",
          defaultBranch: "main",
          isPrivate: false,
          isArchived: false,
          isFork: false,
        },
        pullRequests: [],
        pullRequestsTruncated: true,
        issues: [],
        issuesTruncated: false,
        runs: [
          {
            databaseId: 10,
            workflowName: "ci",
            displayTitle: "Build",
            status: "completed",
            conclusion: "failure",
            url: "https://github.com/espresso95/mottbot/actions/runs/10",
          },
        ],
      }),
    ).toContain("Latest CI: ci completed/failure");
    expect(
      formatGithubStatusSummary({
        metadata: {
          repository: "espresso95/mottbot",
          url: "https://github.com/espresso95/mottbot",
          description: "",
          defaultBranch: "main",
          isPrivate: false,
          isArchived: false,
          isFork: false,
        },
        pullRequests: [],
        pullRequestsTruncated: true,
        issues: [],
        runs: [],
      }),
    ).toContain("Open PRs listed: 0+");
  });
});
