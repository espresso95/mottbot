#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Api } from "grammy";
import type { AppConfig } from "../../src/app/config.js";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import type { Clock } from "../../src/shared/clock.js";
import { MemoryStore } from "../../src/sessions/memory-store.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import type { SessionRoute } from "../../src/sessions/types.js";
import { ProjectCommandRouter } from "../../src/project-tasks/project-command-router.js";
import { ProjectTaskStore } from "../../src/project-tasks/project-task-store.js";
import {
  buildMemoryCandidateAcceptCallbackData,
  buildProjectApprovalCallbackData,
  buildToolApprovalCallbackData,
} from "../../src/telegram/callback-data.js";
import { handleMemoryCandidateCallback } from "../../src/telegram/memory-commands.js";
import type { TelegramCallbackEvent } from "../../src/telegram/types.js";
import { handleToolApprovalCallback, handleToolDenyCallback } from "../../src/telegram/tool-commands.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { createRuntimeToolRegistry } from "../../src/tools/registry.js";

type CallbackSmokeStatus = "passed" | "failed";

/** Result for one Telegram callback smoke scenario. */
export type TelegramCallbackSmokeScenarioResult = {
  name: string;
  status: CallbackSmokeStatus;
  details?: Record<string, unknown>;
  error?: string;
};

/** Aggregate result for in-process Telegram callback validation. */
export type TelegramCallbackSmokeResult = {
  status: CallbackSmokeStatus;
  tempRoot: string;
  scenarios: TelegramCallbackSmokeScenarioResult[];
};

class FixedClock implements Clock {
  constructor(private readonly value = 1_700_000_000_000) {}

  now(): number {
    return this.value;
  }
}

class RecordingApi {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  async answerCallbackQuery(...args: unknown[]): Promise<Record<string, never>> {
    this.calls.push({ method: "answerCallbackQuery", args });
    return {};
  }

  async editMessageText(...args: unknown[]): Promise<Record<string, never>> {
    this.calls.push({ method: "editMessageText", args });
    return {};
  }

  async editMessageReplyMarkup(...args: unknown[]): Promise<Record<string, never>> {
    this.calls.push({ method: "editMessageReplyMarkup", args });
    return {};
  }

  async sendMessage(...args: unknown[]): Promise<Record<string, never>> {
    this.calls.push({ method: "sendMessage", args });
    return {};
  }

  hasCall(method: string): boolean {
    return this.calls.some((call) => call.method === method);
  }
}

const toolsConfig = {
  enableSideEffectTools: true,
  approvalTtlMs: 60_000,
  restartDelayMs: 60_000,
} as AppConfig["tools"];

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function callbackEvent(overrides: Partial<TelegramCallbackEvent> = {}): TelegramCallbackEvent {
  return {
    updateId: 1,
    callbackQueryId: "callback-1",
    chatId: "chat-1",
    chatType: "private",
    messageId: 42,
    fromUserId: "admin-1",
    fromUsername: "admin",
    data: "mb:unknown:1",
    messageText: "Approval required.",
    arrivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function sessionRoute(): SessionRoute {
  return {
    sessionKey: "tg:dm:chat-1:user:admin-1",
    chatId: "chat-1",
    userId: "admin-1",
    routeMode: "dm",
    agentId: "main",
    profileId: "openai-codex:default",
    modelRef: "openai-codex/gpt-5.4",
    fastMode: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

async function runScenario(
  name: string,
  run: () => Promise<Record<string, unknown> | undefined>,
): Promise<TelegramCallbackSmokeScenarioResult> {
  try {
    return {
      name,
      status: "passed",
      details: await run(),
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Exercises callback handlers without needing a live Telegram update. */
export async function createTelegramCallbackSmokeResult(): Promise<TelegramCallbackSmokeResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottbot-telegram-callback-smoke-"));
  const database = new DatabaseClient(path.join(tempRoot, "smoke.sqlite"));
  const clock = new FixedClock();
  try {
    migrateDatabase(database);
    const session = new SessionStore(database, clock).ensure(sessionRoute());
    const registry = createRuntimeToolRegistry({ enableSideEffectTools: true });
    const approvals = new ToolApprovalStore(database, clock);
    const memories = new MemoryStore(database, clock);
    const projects = new ProjectTaskStore(database, clock);
    const api = new RecordingApi();
    const scenarios = await Promise.all([
      runScenario("tool approval callback", async () => {
        const pending = approvals.recordAudit({
          sessionKey: session.sessionKey,
          toolName: "mottbot_restart_service",
          sideEffect: "process_control",
          allowed: false,
          decisionCode: "approval_required",
          requestedAt: clock.now(),
          decidedAt: clock.now(),
          requestFingerprint: "fingerprint-approve",
          previewText: "Restart service.",
        });
        let continued = false;
        await handleToolApprovalCallback(
          {
            api: api as unknown as Api,
            event: callbackEvent({ data: buildToolApprovalCallbackData(pending.id!) }),
            session,
            toolsConfig,
            isAdmin: true,
            toolRegistry: registry,
            toolApprovals: approvals,
            continueAfterApproval: async () => {
              continued = true;
            },
          },
          pending.id!,
        );
        assert(continued, "approval callback did not request continuation");
        assert(api.hasCall("editMessageText"), "approval callback did not edit the source message");
        assert(approvals.listActive(session.sessionKey).length === 1, "approval was not stored");
        return { activeApprovals: approvals.listActive(session.sessionKey).length };
      }),
      runScenario("tool deny callback", async () => {
        const pending = approvals.recordAudit({
          sessionKey: session.sessionKey,
          toolName: "mottbot_restart_service",
          sideEffect: "process_control",
          allowed: false,
          decisionCode: "approval_required",
          requestedAt: clock.now(),
          decidedAt: clock.now(),
          requestFingerprint: "fingerprint-deny",
          previewText: "Restart service.",
        });
        await handleToolDenyCallback(
          {
            api: api as unknown as Api,
            event: callbackEvent({ callbackQueryId: "callback-2", data: `mb:td:${pending.id}` }),
            session,
            toolsConfig,
            isAdmin: true,
            toolRegistry: registry,
            toolApprovals: approvals,
          },
          pending.id!,
        );
        const denied = approvals.listAudit({
          sessionKey: session.sessionKey,
          decisionCode: "operator_denied",
        });
        assert(denied.length === 1, "denial was not audited");
        return { denied: denied.length };
      }),
      runScenario("memory candidate accept callback", async () => {
        const candidate = memories.addCandidate({
          sessionKey: session.sessionKey,
          scope: "personal",
          scopeKey: "admin-1",
          contentText: "User prefers Telegram buttons for reviews.",
          sensitivity: "low",
        });
        assert(candidate.inserted, "candidate was not inserted");
        await handleMemoryCandidateCallback(
          {
            api: api as unknown as Api,
            event: callbackEvent({
              callbackQueryId: "callback-3",
              data: buildMemoryCandidateAcceptCallbackData(candidate.candidate.id),
            }),
            session,
            memories,
          },
          "accept",
          candidate.candidate.id,
        );
        assert(memories.listForScopeContext(session).length === 1, "candidate was not accepted");
        return { acceptedMemories: memories.listForScopeContext(session).length };
      }),
      runScenario("project approval callback", async () => {
        const task = projects.createTask({
          chatId: "chat-1",
          repoRoot: tempRoot,
          baseRef: "main",
          title: "project smoke",
          originalPrompt: "ship project smoke",
          status: "awaiting_approval",
          maxParallelWorkers: 1,
          maxAttemptsPerSubtask: 1,
        });
        const approval = projects.createApproval({
          taskId: task.taskId,
          requestedBy: "admin-1",
          requestJson: JSON.stringify({ prompt: "ship project smoke" }),
        });
        let approvedBy: string | undefined;
        const router = new ProjectCommandRouter(
          api as unknown as Api,
          {
            projectTasks: {
              enabled: true,
              repoRoots: [tempRoot],
              approvals: { requireBeforeProjectStart: true },
              defaultBaseRef: "main",
              defaultMaxParallelWorkersPerProject: 1,
            },
          } as AppConfig,
          projects,
          {
            approveApproval: (approvalId: string, decidedBy?: string) => {
              approvedBy = decidedBy;
              projects.decideApproval(approvalId, { status: "approved", decidedBy });
              projects.updateTask(task.taskId, { status: "queued" });
              return { ok: true, message: `Approved ${approvalId}.` };
            },
          } as never,
        );

        await router.handleApprovalCallback(
          callbackEvent({
            callbackQueryId: "callback-4",
            data: buildProjectApprovalCallbackData(approval.approvalId),
            messageText: "Project ready to start.",
          }),
          approval.approvalId,
        );

        assert(approvedBy === "admin-1", "project approval callback did not pass the operator id");
        assert(projects.getTask(task.taskId)?.status === "queued", "project approval did not queue the task");
        assert(
          api.calls.some(
            (call) =>
              call.method === "editMessageText" &&
              typeof call.args[2] === "string" &&
              call.args[2].includes("Approved project request."),
          ),
          "project approval callback did not mark the source message",
        );
        return { taskStatus: projects.getTask(task.taskId)?.status };
      }),
    ]);
    const failed = scenarios.some((scenario) => scenario.status === "failed");
    return {
      status: failed ? "failed" : "passed",
      tempRoot,
      scenarios,
    };
  } finally {
    database.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await createTelegramCallbackSmokeResult();
  printJson({
    ...result,
    tempRoot: "[removed]",
  });
  process.exitCode = result.status === "passed" ? 0 : 1;
}

/* v8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    printJson({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
