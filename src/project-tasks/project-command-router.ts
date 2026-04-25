import fs from "node:fs";
import path from "node:path";
import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import type { InboundEvent } from "../telegram/types.js";
import type { ProjectTaskStore } from "./project-task-store.js";
import type { ProjectTaskScheduler } from "./project-task-scheduler.js";

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

async function sendReply(api: Api, event: InboundEvent, text: string): Promise<void> {
  for (const chunk of splitTelegramText(text)) {
    await api.sendMessage(event.chatId, chunk, {
      ...(typeof event.threadId === "number" ? { message_thread_id: event.threadId } : {}),
      reply_parameters: { message_id: event.messageId },
    });
  }
}

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
    if (sub === "approve") {
      await this.handleApprove(event, rest[0], event.fromUserId);
      return;
    }
    await sendReply(this.api, event, "Usage: /project start <repo> <task> | status [task] | tail <subtask> | cancel <task> | approve <approval>");
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
    const requiresApproval = this.config.projectTasks.approvals.requireBeforeProjectStart;
    const task = this.store.createTask({
      chatId: event.chatId,
      requestedByUserId: event.fromUserId,
      requestedByUsername: event.fromUsername,
      repoRoot,
      baseRef: this.config.projectTasks.defaultBaseRef,
      title,
      originalPrompt: prompt,
      status: requiresApproval ? "awaiting_approval" : "queued",
      maxParallelWorkers: this.config.projectTasks.defaultMaxParallelWorkersPerProject,
      maxAttemptsPerSubtask: 2,
    });
    this.store.createSubtask({
      taskId: task.taskId,
      title: "primary-worker",
      role: "worker",
      prompt,
      status: "ready",
    });
    if (requiresApproval) {
      const approval = this.store.createApproval({
        taskId: task.taskId,
        requestedBy: event.fromUserId,
        requestJson: JSON.stringify({ repoRoot, prompt }),
      });
      await sendReply(this.api, event, `Created task ${task.taskId}. Awaiting approval ${approval.approvalId}. Run /project approve ${approval.approvalId}`);
      return;
    }
    await sendReply(this.api, event, `Started project task ${task.taskId} in ${repoRoot}.`);
  }

  private async handleStatus(event: InboundEvent, taskId?: string): Promise<void> {
    const targetTask = taskId?.trim() ? this.store.getTask(taskId.trim()) : this.store.listTasksByChat(event.chatId, 1)[0];
    if (!targetTask) {
      await sendReply(this.api, event, "No project tasks found.");
      return;
    }
    const snapshot = this.store.projectSnapshot(targetTask.taskId);
    if (!snapshot) {
      await sendReply(this.api, event, "Task not found.");
      return;
    }
    const subtaskLines = snapshot.subtasks.map((subtask) => `- ${subtask.subtaskId.slice(0, 8)} ${subtask.title}: ${subtask.status}`).join("\n") || "- none";
    await sendReply(
      this.api,
      event,
      [
        `Project: ${snapshot.task.title}`,
        `Task ID: ${snapshot.task.taskId}`,
        `Status: ${snapshot.task.status}`,
        `Repo: ${snapshot.task.repoRoot}`,
        `Active runs: ${snapshot.activeRuns.length}`,
        "Subtasks:",
        subtaskLines,
        ...(snapshot.task.finalSummary ? ["Summary:", snapshot.task.finalSummary] : []),
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
    await sendReply(this.api, event, [`Subtask: ${subtask.title}`, `Status: ${subtask.status}`, "Events:", lines.join("\n") || "- no events yet"].join("\n"));
  }

  private async handleCancel(event: InboundEvent, taskId?: string): Promise<void> {
    if (!taskId?.trim()) {
      await sendReply(this.api, event, "Usage: /project cancel <task-id>");
      return;
    }
    const result = this.scheduler.cancelTask(taskId.trim());
    await sendReply(this.api, event, result.message);
  }

  private async handleApprove(event: InboundEvent, approvalId?: string, decidedBy?: string): Promise<void> {
    if (!approvalId?.trim()) {
      await sendReply(this.api, event, "Usage: /project approve <approval-id>");
      return;
    }
    const approval = this.store.getApproval(approvalId.trim());
    if (!approval) {
      await sendReply(this.api, event, `Unknown approval ${approvalId}.`);
      return;
    }
    if (approval.status !== "pending") {
      await sendReply(this.api, event, `Approval ${approvalId} is already ${approval.status}.`);
      return;
    }
    this.store.decideApproval(approval.approvalId, {
      status: "approved",
      decidedBy,
    });
    this.store.updateTask(approval.taskId, {
      status: "queued",
    });
    await sendReply(this.api, event, `Approved ${approvalId}. Task ${approval.taskId} queued.`);
  }

  private resolveRepoRoot(raw: string): string | undefined {
    const input = path.resolve(raw.startsWith("~") ? path.join(process.env.HOME ?? "", raw.slice(1)) : raw);
    for (const root of this.config.projectTasks.repoRoots) {
      const normalizedRoot = path.resolve(root);
      if (input === normalizedRoot || input.startsWith(`${normalizedRoot}${path.sep}`)) {
        return input;
      }
    }
    return undefined;
  }
}
