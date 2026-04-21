#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseClient } from "../db/client.js";
import { migrateDatabase } from "../db/migrate.js";
import type { Clock } from "../shared/clock.js";
import { SessionStore } from "../sessions/session-store.js";
import { ToolApprovalStore } from "./approval.js";
import { ToolExecutor, type ToolExecutionResult } from "./executor.js";
import { createGithubToolHandlers } from "./github-handlers.js";
import { GithubCliReadService, type GithubReadOperations, type GithubWriteOperations } from "./github-read.js";
import { createToolRequestFingerprint } from "./policy.js";
import { createRuntimeToolRegistry } from "./registry.js";
import { loadConfig } from "../app/config.js";

type GithubWriteSmokeStatus = "passed" | "failed" | "skipped" | "dry-run" | "blocked";

export type GithubWriteSmokeScenario = {
  name: string;
  status: "passed" | "failed";
  details?: Record<string, unknown>;
  error?: string;
};

export type GithubWriteSmokeResult = {
  status: GithubWriteSmokeStatus;
  reason?: string;
  issues?: string[];
  plan?: Array<{ name: string; toolName: string; repository: string }>;
  scenarios?: GithubWriteSmokeScenario[];
};

type GithubWriteSmokePlan = {
  enabled: boolean;
  dryRun: boolean;
  confirmed: boolean;
  repository: string;
  title: string;
  body: string;
  labels: string[];
  prNumber?: number;
  issues: string[];
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

function labelsFromEnv(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ].slice(0, 10);
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

function prNumberFromEnv(value: string | undefined): number | undefined {
  if (!optionalString(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function buildGithubWriteSmokePlan(env: NodeJS.ProcessEnv): GithubWriteSmokePlan {
  const repository = optionalString(env.MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY) ?? "";
  const prNumberRaw = optionalString(env.MOTTBOT_GITHUB_WRITE_SMOKE_PR_NUMBER);
  const prNumber = prNumberFromEnv(prNumberRaw);
  const title =
    optionalString(env.MOTTBOT_GITHUB_WRITE_SMOKE_TITLE) ??
    `[mottbot smoke] GitHub write validation ${new Date().toISOString()}`;
  const body =
    optionalString(env.MOTTBOT_GITHUB_WRITE_SMOKE_BODY) ??
    "This disposable issue was created by the guarded Mottbot GitHub write smoke harness.";
  const labels = labelsFromEnv(env.MOTTBOT_GITHUB_WRITE_SMOKE_LABELS);
  const enabled = env.MOTTBOT_GITHUB_WRITE_SMOKE_ENABLED === "true";
  const dryRun = env.MOTTBOT_GITHUB_WRITE_SMOKE_DRY_RUN === "true";
  const confirmed = env.MOTTBOT_GITHUB_WRITE_SMOKE_CONFIRM === CONFIRMATION_PHRASE;
  const issues = [
    enabled && !repository ? "MOTTBOT_GITHUB_WRITE_SMOKE_REPOSITORY is required." : undefined,
    enabled && !dryRun && !confirmed
      ? `MOTTBOT_GITHUB_WRITE_SMOKE_CONFIRM must equal ${CONFIRMATION_PHRASE}.`
      : undefined,
    enabled && prNumberRaw && prNumber === undefined
      ? "MOTTBOT_GITHUB_WRITE_SMOKE_PR_NUMBER must be a positive integer when set."
      : undefined,
  ].filter((issue): issue is string => Boolean(issue));
  return {
    enabled,
    dryRun,
    confirmed,
    repository,
    title,
    body,
    labels,
    ...(prNumber ? { prNumber } : {}),
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
  const parsed = JSON.parse(result.contentText);
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

export async function createGithubWriteValidationSuiteResult(params: {
  env?: NodeJS.ProcessEnv;
  github?: GithubReadOperations & GithubWriteOperations;
} = {}): Promise<GithubWriteSmokeResult> {
  const env = params.env ?? process.env;
  const plan = buildGithubWriteSmokePlan(env);
  if (!plan.enabled) {
    return {
      status: "skipped",
      reason: "Set MOTTBOT_GITHUB_WRITE_SMOKE_ENABLED=true to validate live GitHub writes.",
    };
  }
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
  const result = await createGithubWriteValidationSuiteResult();
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
