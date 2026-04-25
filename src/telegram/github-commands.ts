import type { Api } from "grammy";
import {
  formatGithubIssues,
  formatGithubPullRequests,
  formatGithubRepositoryMetadata,
  formatGithubStatusSummary,
  formatGithubWorkflowRuns,
  type GithubReadOperations,
} from "../tools/github-read.js";
import { sendReply } from "./command-replies.js";
import type { InboundEvent } from "./types.js";

/** Dependencies needed by the Telegram GitHub command handler. */
export type GithubCommandDependencies = {
  api: Api;
  event: InboundEvent;
  args: string[];
  github?: GithubReadOperations;
  isAdmin: boolean;
};

function parseGithubArgs(args: string[], defaultLimit = 5): { limit: number; repository?: string } {
  let limit = defaultLimit;
  let repository: string | undefined;
  for (const raw of args) {
    const value = raw.trim();
    if (!value) {
      continue;
    }
    if (/^\d+$/.test(value)) {
      limit = Math.min(Math.max(Number(value), 1), 50);
      continue;
    }
    repository = value.startsWith("repo:") ? value.slice("repo:".length) : value;
  }
  return {
    limit,
    ...(repository ? { repository } : {}),
  };
}

/** Handles read-only /github and /gh inspection commands. */
export async function handleGithubCommand(params: GithubCommandDependencies): Promise<void> {
  const { api, event, args, github, isAdmin } = params;
  if (!isAdmin) {
    await sendReply(api, event, "Only owner/admin roles can inspect GitHub.");
    return;
  }
  if (!github) {
    await sendReply(api, event, "GitHub integration is not available.");
    return;
  }
  const requestedSub = args[0]?.toLowerCase();
  const knownSubcommands = new Set([
    "help",
    "status",
    "repo",
    "prs",
    "pulls",
    "issues",
    "runs",
    "ci",
    "failures",
    "failed",
  ]);
  const sub = requestedSub && knownSubcommands.has(requestedSub) ? requestedSub : "status";
  const rest = sub === "status" && requestedSub && !knownSubcommands.has(requestedSub) ? args : args.slice(1);
  const parsed = parseGithubArgs(rest);
  try {
    if (sub === "help") {
      await sendReply(
        api,
        event,
        [
          "GitHub commands",
          "- /github status [repository]",
          "- /github repo [repository]",
          "- /github prs [limit] [repository]",
          "- /github issues [limit] [repository]",
          "- /github runs [limit] [repository]",
          "- /github failures [limit] [repository]",
        ].join("\n"),
      );
      return;
    }
    if (sub === "status") {
      const [metadata, pullRequests, issues, runs] = await Promise.all([
        github.repository({ repository: parsed.repository }),
        github.openPullRequests({ repository: parsed.repository, limit: parsed.limit }),
        github.recentIssues({ repository: parsed.repository, limit: parsed.limit }),
        github.ciStatus({ repository: parsed.repository, limit: parsed.limit }),
      ]);
      await sendReply(
        api,
        event,
        formatGithubStatusSummary({
          metadata,
          pullRequests: pullRequests.pullRequests,
          pullRequestsTruncated: pullRequests.truncated,
          issues: issues.issues,
          issuesTruncated: issues.truncated,
          runs: runs.runs,
        }),
      );
      return;
    }
    if (sub === "repo") {
      await sendReply(api, event, formatGithubRepositoryMetadata(await github.repository(parsed)));
      return;
    }
    if (sub === "prs" || sub === "pulls") {
      const result = await github.openPullRequests(parsed);
      await sendReply(api, event, formatGithubPullRequests(result.repository, result.pullRequests));
      return;
    }
    if (sub === "issues") {
      const result = await github.recentIssues(parsed);
      await sendReply(api, event, formatGithubIssues(result.repository, result.issues));
      return;
    }
    if (sub === "runs" || sub === "ci") {
      const result = await github.ciStatus(parsed);
      await sendReply(
        api,
        event,
        formatGithubWorkflowRuns({ repository: result.repository, title: "Recent workflow runs", runs: result.runs }),
      );
      return;
    }
    if (sub === "failures" || sub === "failed") {
      const result = await github.recentWorkflowFailures(parsed);
      await sendReply(
        api,
        event,
        formatGithubWorkflowRuns({
          repository: result.repository,
          title: "Recent failed workflow runs",
          runs: result.runs,
        }),
      );
      return;
    }
  } catch (error) {
    await sendReply(api, event, error instanceof Error ? error.message : String(error));
    return;
  }
  await sendReply(api, event, "Usage: /github status|repo|prs|issues|runs|failures [limit] [repository]");
}
