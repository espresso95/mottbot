#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../src/app/config.js";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import type { Clock } from "../../src/shared/clock.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { ToolExecutor, type ToolExecutionResult } from "../../src/tools/executor.js";
import { createGithubToolHandlers } from "../../src/tools/github-handlers.js";
import {
  GithubCliReadService,
  type GithubReadOperations,
  type GithubWriteOperations,
} from "../../src/tools/github-read.js";
import { createToolRequestFingerprint } from "../../src/tools/policy.js";
import { createRuntimeToolRegistry } from "../../src/tools/registry.js";
import { booleanFlag, parseCliArgs, positiveIntegerFlag, stringFlag, stringListFlag } from "./cli-args.js";

type GithubWriteSmokeStatus = "passed" | "failed" | "skipped" | "dry-run" | "blocked";

/** Result for one guarded GitHub write smoke scenario. */
export type GithubWriteSmokeScenario = {
  name: string;
  status: "passed" | "failed";
  details?: Record<string, unknown>;
  error?: string;
};

/** Aggregate result for the guarded GitHub write validation suite. */
export type GithubWriteSmokeResult = {
  status: GithubWriteSmokeStatus;
  reason?: string;
  issues?: string[];
  plan?: Array<{ name: string; toolName: string; repository: string }>;
  scenarios?: GithubWriteSmokeScenario[];
};

type GithubWriteSmokePlan = {
  dryRun: boolean;
  confirmed: boolean;
  repository: string;
  title: string;
  body: string;
  labels: string[];
  prNumber?: number;
  issues: string[];
};

/** CLI options for the guarded GitHub write smoke harness. */
export type GithubWriteSmokeOptions = {
  dryRun?: boolean;
  repository?: string;
  confirm?: string;
  title?: string;
  body?: string;
  labels?: string[];
  prNumber?: number;
};

const ADMIN_USER_ID = "github-write-validation-admin";
const SESSION_KEY = "github-write-validation-session";
const CONFIRMATION_PHRASE = "create-live-github-issue";

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readGithubToolConfigFromRuntime(): {
  defaultRepository?: string;
  command: string;
  commandTimeoutMs: number;
  maxItems: number;
  maxOutputBytes: number;
} {
  try {
    return loadConfig().tools.github;
  } catch {
    return {
      command: "gh",
      commandTimeoutMs: 10_000,
      maxItems: 10,
      maxOutputBytes: 80_000,
    };
  }
}

/** Builds GitHub write smoke options from CLI flags. */
export function parseGithubWriteSmokeOptions(argv: readonly string[]): GithubWriteSmokeOptions {
  const args = parseCliArgs(argv);
  const labels = [...stringListFlag(args, "label"), ...stringListFlag(args, "labels")];
  return {
    dryRun: booleanFlag(args, "dry-run", true),
    ...(stringFlag(args, "repository") ? { repository: stringFlag(args, "repository") } : {}),
    ...(stringFlag(args, "confirm") ? { confirm: stringFlag(args, "confirm") } : {}),
    ...(stringFlag(args, "title") ? { title: stringFlag(args, "title") } : {}),
    ...(stringFlag(args, "body") ? { body: stringFlag(args, "body") } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(positiveIntegerFlag(args, "pr-number") ? { prNumber: positiveIntegerFlag(args, "pr-number") } : {}),
  };
}

/** Builds the GitHub write smoke plan from CLI options without performing writes. */
export function buildGithubWriteSmokePlan(options: GithubWriteSmokeOptions): GithubWriteSmokePlan {
  const repository = optionalString(options.repository) ?? "";
  const title = optionalString(options.title) ?? `[mottbot smoke] GitHub write validation ${new Date().toISOString()}`;
  const body =
    optionalString(options.body) ??
    "This disposable issue was created by the guarded Mottbot GitHub write smoke harness.";
  const labels = [...new Set(options.labels ?? [])].slice(0, 10);
  const dryRun = options.dryRun ?? true;
  const confirmed = options.confirm === CONFIRMATION_PHRASE;
  const issues = [
    !repository ? "--repository is required." : undefined,
    !dryRun && !confirmed ? `--confirm must equal ${CONFIRMATION_PHRASE}.` : undefined,
  ].filter((issue): issue is string => Boolean(issue));
  return {
    dryRun,
    confirmed,
    repository,
    title,
    body,
    labels,
    ...(options.prNumber ? { prNumber: options.prNumber } : {}),
    issues,
  };
}

function planSummary(plan: GithubWriteSmokePlan): Array<{ name: string; toolName: string; repository: string }> {
  return [
    {
      name: "create disposable GitHub issue",
      toolName: "mottbot_github_issue_create",
      repository: plan.repository,
    },
    {
      name: "comment on created GitHub issue",
      toolName: "mottbot_github_issue_comment",
      repository: plan.repository,
    },
    ...(plan.prNumber
      ? [
          {
            name: "comment on configured GitHub pull request",
            toolName: "mottbot_github_pr_comment",
            repository: plan.repository,
          },
        ]
      : []),
  ];
}

function parseToolJson(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) {
    throw new Error(result.contentText);
  }
  const parsed: unknown = JSON.parse(result.contentText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Tool ${result.toolName} returned non-object JSON.`);
  }
  return parsed as Record<string, unknown>;
}

async function executeApproved(params: {
  executor: ToolExecutor;
  approvals: ToolApprovalStore;
  toolName: string;
  callId: string;
  arguments: Record<string, unknown>;
}): Promise<ToolExecutionResult> {
  const call = {
    id: `${params.callId}-denied`,
    name: params.toolName,
    arguments: params.arguments,
  };
  const denied = await params.executor.execute(call, {
    sessionKey: SESSION_KEY,
    requestedByUserId: ADMIN_USER_ID,
    chatId: "github-write-validation",
  });
  if (!denied.isError || denied.errorCode !== "approval_required") {
    throw new Error(`Expected approval_required for ${params.toolName}, got ${denied.errorCode ?? "success"}.`);
  }
  params.approvals.approve({
    sessionKey: SESSION_KEY,
    toolName: params.toolName,
    approvedByUserId: ADMIN_USER_ID,
    reason: "GitHub write smoke validation",
    ttlMs: 60_000,
    requestFingerprint: createToolRequestFingerprint({
      toolName: params.toolName,
      arguments: params.arguments,
    }),
  });
  return await params.executor.execute(
    {
      id: params.callId,
      name: params.toolName,
      arguments: params.arguments,
    },
    {
      sessionKey: SESSION_KEY,
      requestedByUserId: ADMIN_USER_ID,
      chatId: "github-write-validation",
    },
  );
}

async function runScenarioOnce(
  name: string,
  run: () => Promise<Record<string, unknown> | undefined>,
): Promise<GithubWriteSmokeScenario> {
  try {
    const details = await run();
    return {
      name,
      status: "passed",
      ...(details ? { details } : {}),
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Executes or dry-runs the guarded GitHub write smoke scenarios. */
export async function createGithubWriteValidationSuiteResult(
  params: {
    options?: GithubWriteSmokeOptions;
    github?: GithubReadOperations & GithubWriteOperations;
  } = {},
): Promise<GithubWriteSmokeResult> {
  const plan = buildGithubWriteSmokePlan(params.options ?? {});
  if (plan.issues.length > 0 && !plan.dryRun) {
    return {
      status: "blocked",
      issues: plan.issues,
      plan: planSummary(plan),
    };
  }
  if (plan.dryRun) {
    return {
      status: "dry-run",
      issues: plan.issues,
      plan: planSummary(plan),
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottbot-github-write-"));
  const databasePath = path.join(tempRoot, "validation.sqlite");
  const database = new DatabaseClient(databasePath);
  try {
    migrateDatabase(database);
    const clock = new SystemClock();
    new SessionStore(database, clock).ensure({
      sessionKey: SESSION_KEY,
      chatId: "github-write-validation",
      userId: ADMIN_USER_ID,
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const approvals = new ToolApprovalStore(database, clock);
    const githubToolConfig = readGithubToolConfigFromRuntime();
    const github =
      params.github ??
      new GithubCliReadService({
        ...githubToolConfig,
        defaultRepository: plan.repository || githubToolConfig.defaultRepository,
      });
    const executor = new ToolExecutor(createRuntimeToolRegistry({ enableSideEffectTools: true }), {
      clock,
      approvals,
      adminUserIds: [ADMIN_USER_ID],
      handlers: createGithubToolHandlers(github),
    });
    const scenarios: GithubWriteSmokeScenario[] = [];
    let issueNumber: number | undefined;

    scenarios.push(
      await runScenarioOnce("create disposable GitHub issue", async () => {
        const output = parseToolJson(
          await executeApproved({
            executor,
            approvals,
            toolName: "mottbot_github_issue_create",
            callId: "github-issue-create",
            arguments: {
              repository: plan.repository,
              title: plan.title,
              body: plan.body,
              labels: plan.labels,
            },
          }),
        );
        issueNumber = typeof output.number === "number" ? output.number : undefined;
        return {
          number: issueNumber,
          url: output.url,
        };
      }),
    );

    if (issueNumber) {
      scenarios.push(
        await runScenarioOnce("comment on created GitHub issue", async () =>
          parseToolJson(
            await executeApproved({
              executor,
              approvals,
              toolName: "mottbot_github_issue_comment",
              callId: "github-issue-comment",
              arguments: {
                repository: plan.repository,
                number: issueNumber,
                body: "Mottbot GitHub write smoke comment.",
              },
            }),
          ),
        ),
      );
    } else {
      scenarios.push({
        name: "comment on created GitHub issue",
        status: "failed",
        error: "Created issue output did not include an issue number.",
      });
    }

    if (plan.prNumber) {
      scenarios.push(
        await runScenarioOnce("comment on configured GitHub pull request", async () =>
          parseToolJson(
            await executeApproved({
              executor,
              approvals,
              toolName: "mottbot_github_pr_comment",
              callId: "github-pr-comment",
              arguments: {
                repository: plan.repository,
                number: plan.prNumber,
                body: "Mottbot GitHub write smoke PR comment.",
              },
            }),
          ),
        ),
      );
    }

    return {
      status: scenarios.some((scenario) => scenario.status === "failed") ? "failed" : "passed",
      scenarios,
    };
  } finally {
    database.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await createGithubWriteValidationSuiteResult({
    options: parseGithubWriteSmokeOptions(process.argv.slice(2)),
  });
  printJson(result);
  process.exitCode = result.status === "failed" || result.status === "blocked" ? 1 : 0;
}

/* v8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printJson({ status: "failed", error: message });
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
