import fs from "node:fs";
import path from "node:path";
import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import type { InboundEvent, TelegramCallbackEvent } from "../telegram/types.js";
import type { CodexCliRun, ProjectSubtask } from "./project-types.js";
import type { ProjectTaskStore } from "./project-task-store.js";
import type { ProjectTaskActionResult, ProjectTaskScheduler } from "./project-task-scheduler.js";
import { buildProjectPlan } from "./project-planner.js";
import { buildProjectApprovalCallbackData } from "../telegram/callback-data.js";
import type { TelegramInlineKeyboard } from "../telegram/command-replies.js";

const TELEGRAM_TEXT_MAX_CHARS = 4096;

function splitTelegramText(text: string): string[] {
  const maxChars = 3_900;
  if (text.length <= maxChars) {
    return [text];
  }
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    chunks.push(text.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return chunks;
}

async function sendReply(
  api: Api,
  event: Pick<InboundEvent | TelegramCallbackEvent, "chatId" | "messageId" | "threadId">,
  text: string,
  replyMarkup?: TelegramInlineKeyboard,
): Promise<void> {
  for (const chunk of splitTelegramText(text)) {
    await api.sendMessage(event.chatId, chunk, {
      ...(typeof event.threadId === "number" ? { message_thread_id: event.threadId } : {}),
      reply_parameters: { message_id: event.messageId },
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

function projectApprovalReplyMarkup(approvalId: string, label: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        {
          text: label,
          callback_data: buildProjectApprovalCallbackData(approvalId),
        },
      ],
    ],
  };
}

async function clearCallbackKeyboard(api: Api, event: TelegramCallbackEvent): Promise<void> {
  try {
    await api.editMessageReplyMarkup(event.chatId, event.messageId);
  } catch {
    // The project decision reply is authoritative; stale keyboard cleanup is best effort.
  }
}

function callbackStatusText(event: TelegramCallbackEvent, status: string): string {
  const cleanStatus = status.replace(/\s+/g, " ").trim();
  const original = event.messageText?.trim();
  if (!original) {
    return cleanStatus;
  }
  const separator = "\n\n";
  const suffix = `${separator}${cleanStatus}`;
  const maxOriginalLength = Math.max(0, TELEGRAM_TEXT_MAX_CHARS - suffix.length);
  return `${original.slice(0, maxOriginalLength).trimEnd()}${suffix}`;
}

async function editCallbackStatus(api: Api, event: TelegramCallbackEvent, status: string): Promise<void> {
  try {
    await api.editMessageText(event.chatId, event.messageId, callbackStatusText(event, status));
  } catch {
    // Some Telegram messages cannot be edited; keyboard cleanup below still prevents stale taps.
  }
  await clearCallbackKeyboard(api, event);
}

function formatRunDetail(run: CodexCliRun | undefined): string {
  if (!run) {
    return "";
  }
  const detail = [`latest run ${run.status}`];
  if (run.lastError) {
    detail.push(run.lastError);
  } else if (typeof run.exitCode === "number") {
    detail.push(`exit ${run.exitCode}`);
  } else if (run.signal) {
    detail.push(`signal ${run.signal}`);
  }
  return `; ${detail.join(": ")}`;
}

function formatSubtaskLine(subtask: ProjectSubtask, latestRun: CodexCliRun | undefined): string {
  const deps =
    subtask.dependsOnSubtaskIds.length > 0
      ? ` (depends on ${subtask.dependsOnSubtaskIds.map((entry) => entry.slice(0, 8)).join(", ")})`
      : "";
  const error = subtask.lastError ? `; error: ${subtask.lastError}` : "";
  return `- ${subtask.subtaskId.slice(0, 8)} ${subtask.title}: ${subtask.status}${deps}${error}${formatRunDetail(latestRun)}`;
}

/** Handles Telegram /project commands and delegates task execution to the project scheduler. */
export class ProjectCommandRouter {
  constructor(
    private readonly api: Api,
    private readonly config: AppConfig,
    private readonly store: ProjectTaskStore,
    private readonly scheduler: ProjectTaskScheduler,
  ) {}

  async handle(event: InboundEvent, args: string[]): Promise<void> {
    if (!this.config.projectTasks.enabled) {
      await sendReply(this.api, event, "Project mode is disabled.");
      return;
    }
    const [subcommand = "status", ...rest] = args;
    const sub = subcommand.toLowerCase();
    if (sub === "start") {
      await this.handleStart(event, rest);
      return;
    }
    if (sub === "status") {
      await this.handleStatus(event, rest[0]);
      return;
    }
    if (sub === "tail") {
      await this.handleTail(event, rest[0]);
      return;
    }
    if (sub === "cancel") {
      await this.handleCancel(event, rest[0]);
      return;
    }
    if (sub === "cleanup") {
      await this.handleCleanup(event, rest[0]);
      return;
    }
    if (sub === "publish") {
      await this.handlePublish(event, rest);
      return;
    }
    if (sub === "approve") {
      await this.handleApprove(event, rest[0], event.fromUserId);
      return;
    }
    await sendReply(
      this.api,
      event,
      "Usage: /project start <repo> <task> | status [task] | tail <subtask> | cancel <task> | cleanup <task> | publish <task> [main|pr] | approve <approval>",
    );
  }

  async handleApprovalCallback(event: TelegramCallbackEvent, approvalId: string): Promise<void> {
    if (!this.config.projectTasks.enabled) {
      await editCallbackStatus(this.api, event, "Project mode is disabled.");
      await sendReply(this.api, event, "Project mode is disabled.");
      return;
    }
    const normalizedApprovalId = approvalId.trim();
    const approval = this.store.getApproval(normalizedApprovalId);
    if (approval) {
      const task = this.store.getTask(approval.taskId);
      if (task?.chatId !== event.chatId) {
        await sendReply(this.api, event, "Project approval is not available in this chat.");
        return;
      }
    }
    const result = this.scheduler.approveApproval(normalizedApprovalId, event.fromUserId);
    await editCallbackStatus(
      this.api,
      event,
      result.ok
        ? `Approved project request. ${result.message}`
        : `Project approval could not be applied. ${result.message}`,
    );
    await sendReply(this.api, event, result.message);
  }

  private async handleStart(event: InboundEvent, args: string[]): Promise<void> {
    const [repoArg, ...promptParts] = args;
    const prompt = promptParts.join(" ").trim();
    if (!repoArg || !prompt) {
      await sendReply(this.api, event, "Usage: /project start <repo> <task>");
      return;
    }
    const repoRoot = this.resolveRepoRoot(repoArg);
    if (!repoRoot) {
      await sendReply(this.api, event, "Repo path is outside allowed project roots.");
      return;
    }
    if (!fs.existsSync(path.join(repoRoot, ".git"))) {
      await sendReply(this.api, event, "Repo path must point to a git checkout.");
      return;
    }
    const title = prompt.split(/\s+/).slice(0, 8).join(" ");
    const plan = buildProjectPlan({ prompt, taskTitle: title });
    const requiresApproval = this.config.projectTasks.approvals.requireBeforeProjectStart;
    const task = this.store.createTask({
      chatId: event.chatId,
      requestedByUserId: event.fromUserId,
      requestedByUsername: event.fromUsername,
      repoRoot,
      baseRef: this.config.projectTasks.defaultBaseRef,
      title,
      originalPrompt: prompt,
      planJson: JSON.stringify(plan),
      status: requiresApproval ? "awaiting_approval" : "queued",
      maxParallelWorkers: this.config.projectTasks.defaultMaxParallelWorkersPerProject,
      maxAttemptsPerSubtask: 2,
    });
    const createdByStepId = new Map<string, string>();
    for (const step of plan.steps) {
      const subtask = this.store.createSubtask({
        taskId: task.taskId,
        title: step.title,
        role: "worker",
        prompt: step.prompt,
        status: step.dependsOnStepIds.length === 0 ? "ready" : "blocked",
      });
      createdByStepId.set(step.stepId, subtask.subtaskId);
    }
    for (const step of plan.steps) {
      const subtaskId = createdByStepId.get(step.stepId);
      if (!subtaskId) {
        continue;
      }
      const dependsOnSubtaskIds = step.dependsOnStepIds
        .map((stepId) => createdByStepId.get(stepId))
        .filter((value): value is string => typeof value === "string");
      if (dependsOnSubtaskIds.length === 0) {
        continue;
      }
      this.store.updateSubtask(subtaskId, { dependsOnSubtaskIds });
    }
    if (requiresApproval) {
      const approval = this.store.createApproval({
        taskId: task.taskId,
        requestedBy: event.fromUserId,
        requestJson: JSON.stringify({ repoRoot, prompt }),
      });
      await sendReply(
        this.api,
        event,
        `Created task ${task.taskId}. Awaiting approval ${approval.approvalId}. Run /project approve ${approval.approvalId}`,
        projectApprovalReplyMarkup(approval.approvalId, "Approve project"),
      );
      return;
    }
    await sendReply(this.api, event, `Started project task ${task.taskId} in ${repoRoot}.`);
  }

  private async handleStatus(event: InboundEvent, taskId?: string): Promise<void> {
    const targetTask = taskId?.trim()
      ? this.store.getTask(taskId.trim())
      : this.store.listTasksByChat(event.chatId, 1)[0];
    if (!targetTask) {
      await sendReply(this.api, event, "No project tasks found.");
      return;
    }
    const snapshot = this.store.projectSnapshot(targetTask.taskId);
    if (!snapshot) {
      await sendReply(this.api, event, "Task not found.");
      return;
    }
    const subtaskLines =
      snapshot.subtasks
        .map((subtask) => {
          const latestRun = this.store.getLatestCliRunForSubtask(subtask.subtaskId);
          return formatSubtaskLine(subtask, latestRun);
        })
        .join("\n") || "- none";
    await sendReply(
      this.api,
      event,
      [
        `Project: ${snapshot.task.title}`,
        `Task ID: ${snapshot.task.taskId}`,
        `Status: ${snapshot.task.status}`,
        `Repo: ${snapshot.task.repoRoot}`,
        ...(snapshot.task.finalBranch ? [`Final branch: ${snapshot.task.finalBranch}`] : []),
        `Active runs: ${snapshot.activeRuns.length}`,
        "Subtasks:",
        subtaskLines,
        ...(snapshot.task.finalDiffStat ? ["Diff stat:", snapshot.task.finalDiffStat] : []),
        ...(snapshot.task.finalSummary ? ["Summary:", snapshot.task.finalSummary] : []),
        ...(snapshot.task.status === "completed" && snapshot.task.finalBranch && snapshot.task.integrationWorktreePath
          ? [`Publish: /project publish ${snapshot.task.taskId} [main|pr]`]
          : []),
        ...(snapshot.task.status === "completed" && snapshot.task.integrationWorktreePath
          ? [`Cleanup: /project cleanup ${snapshot.task.taskId}`]
          : []),
        ...(snapshot.task.lastError ? ["Last error:", snapshot.task.lastError] : []),
      ].join("\n"),
    );
  }

  private async handleTail(event: InboundEvent, subtaskId?: string): Promise<void> {
    const id = subtaskId?.trim();
    if (!id) {
      await sendReply(this.api, event, "Usage: /project tail <subtask-id>");
      return;
    }
    const subtask = this.store.getSubtask(id);
    if (!subtask) {
      await sendReply(this.api, event, `Unknown subtask ${id}.`);
      return;
    }
    const runs = this.store.listActiveCliRuns(subtask.taskId);
    const run = runs.find((entry) => entry.subtaskId === subtask.subtaskId) ?? runs.at(-1);
    if (!run) {
      await sendReply(this.api, event, `No active codex run for ${id}.`);
      return;
    }
    const events = this.store.listCliEvents(run.cliRunId, 10);
    const lines = events.map((entry) => {
      const parsed = JSON.parse(entry.eventJson) as { type?: string; text?: string; message?: string };
      const details = parsed.text ?? parsed.message ?? "";
      return `- #${entry.eventIndex} ${entry.eventType ?? "event"}${details ? `: ${details}` : ""}`;
    });
    await sendReply(
      this.api,
      event,
      [`Subtask: ${subtask.title}`, `Status: ${subtask.status}`, "Events:", lines.join("\n") || "- no events yet"].join(
        "\n",
      ),
    );
  }

  private async handleCancel(event: InboundEvent, taskId?: string): Promise<void> {
    if (!taskId?.trim()) {
      await sendReply(this.api, event, "Usage: /project cancel <task-id>");
      return;
    }
    const result = this.scheduler.cancelTask(taskId.trim());
    await sendReply(this.api, event, result.message);
  }

  private async handleCleanup(event: InboundEvent, taskId?: string): Promise<void> {
    if (!taskId?.trim()) {
      await sendReply(this.api, event, "Usage: /project cleanup <task-id>");
      return;
    }
    const result = this.scheduler.cleanupTask(taskId.trim());
    await sendReply(this.api, event, result.message);
  }

  private async handlePublish(event: InboundEvent, args: string[]): Promise<void> {
    const [taskId, ...options] = args;
    if (!taskId?.trim()) {
      await sendReply(this.api, event, "Usage: /project publish <task-id> [main|pr]");
      return;
    }
    const publishOptions = this.parsePublishOptions(options);
    if (!publishOptions.ok) {
      await sendReply(this.api, event, publishOptions.message);
      return;
    }
    const result = this.scheduler.requestPublishApproval({
      taskId: taskId.trim(),
      requestedBy: event.fromUserId,
      openPullRequest: publishOptions.openPullRequest,
      pushToBaseRef: publishOptions.pushToBaseRef,
    });
    await sendReply(this.api, event, result.message, this.publishApprovalReplyMarkup(result));
  }

  private parsePublishOptions(
    options: string[],
  ): { ok: true; openPullRequest: boolean; pushToBaseRef: boolean } | { ok: false; message: string } {
    let openPullRequest = false;
    let pushToBaseRef = false;
    for (const option of options) {
      const normalized = option.toLowerCase();
      if (normalized === "pr" || normalized === "--pr" || normalized === "pull-request") {
        openPullRequest = true;
        continue;
      }
      if (normalized === "main" || normalized === "--main" || normalized === "base" || normalized === "--base") {
        pushToBaseRef = true;
        continue;
      }
      return {
        ok: false,
        message: `Unknown publish option ${option}. Usage: /project publish <task-id> [main|pr]`,
      };
    }
    if (openPullRequest && pushToBaseRef) {
      return {
        ok: false,
        message: "Choose either main or pr for publish, not both.",
      };
    }
    return { ok: true, openPullRequest, pushToBaseRef };
  }

  private async handleApprove(event: InboundEvent, approvalId?: string, decidedBy?: string): Promise<void> {
    if (!approvalId?.trim()) {
      await sendReply(this.api, event, "Usage: /project approve <approval-id>");
      return;
    }
    const result = this.scheduler.approveApproval(approvalId.trim(), decidedBy);
    await sendReply(this.api, event, result.message);
  }

  private publishApprovalReplyMarkup(result: ProjectTaskActionResult): TelegramInlineKeyboard | undefined {
    return result.approvalId ? projectApprovalReplyMarkup(result.approvalId, "Approve publish") : undefined;
  }

  private resolveRepoRoot(raw: string): string | undefined {
    const expanded = path.resolve(raw.startsWith("~") ? path.join(process.env.HOME ?? "", raw.slice(1)) : raw);
    if (!fs.existsSync(expanded)) {
      return undefined;
    }
    const input = fs.realpathSync(expanded);
    for (const root of this.config.projectTasks.repoRoots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      const normalizedRoot = fs.realpathSync(path.resolve(root));
      if (input === normalizedRoot || input.startsWith(`${normalizedRoot}${path.sep}`)) {
        return input;
      }
    }
    return undefined;
  }
}
