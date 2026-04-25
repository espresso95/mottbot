import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../app/config.js";
import type { Clock } from "../shared/clock.js";
import type { CodexCliRunner } from "../codex-cli/codex-cli-runner.js";
import type { ProjectTaskStore } from "./project-task-store.js";
import type { WorktreeManager } from "../worktrees/worktree-manager.js";

export class ProjectTaskScheduler {
  private timer?: NodeJS.Timeout;
  private readonly activeSubtasks = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly store: ProjectTaskStore,
    private readonly runner: CodexCliRunner,
    private readonly worktrees: WorktreeManager,
  ) {}

  start(): void {
    if (!this.config.projectTasks.enabled || this.timer) {
      return;
    }
    fs.mkdirSync(this.config.projectTasks.artifactRoot, { recursive: true });
    this.timer = setInterval(() => {
      void this.tick();
    }, 2_000);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const tasks = this.store.listRunnableTasks(20);
    for (const task of tasks) {
      if (task.status === "queued") {
        this.store.updateTask(task.taskId, { status: "running", startedAt: this.clock.now() });
      }
      if (task.status !== "queued" && task.status !== "running") {
        continue;
      }
      const subtasks = this.store.listSubtasks(task.taskId);
      this.refreshDependencyStates(subtasks);
      const dependencyRefreshedSubtasks = this.store.listSubtasks(task.taskId);
      const runningSubtasks = dependencyRefreshedSubtasks.filter((subtask) => subtask.status === "running");
      const activeRuns = this.store.listActiveCliRuns(task.taskId);
      if (runningSubtasks.length > 0 && activeRuns.length === 0) {
        for (const subtask of runningSubtasks) {
          const finalSummary = this.readFinalSummary(task.taskId, subtask.subtaskId);
          const protectedChanges = subtask.worktreePath
            ? this.worktrees.listProtectedChanges(subtask.worktreePath)
            : [];
          const protectedPathError =
            protectedChanges.length > 0
              ? `Protected paths modified: ${protectedChanges.slice(0, 8).join(", ")}`
              : undefined;
          const failureError = protectedPathError ?? finalSummary.text ?? "Worker failed";
          this.store.updateSubtask(subtask.subtaskId, {
            status: finalSummary.failed || !!protectedPathError ? "failed" : "completed",
            finishedAt: this.clock.now(),
            ...(finalSummary.text ? { resultSummary: finalSummary.text } : {}),
            ...(finalSummary.failed || protectedPathError ? { lastError: failureError } : {}),
          });
          if (subtask.worktreePath || subtask.branchName) {
            this.worktrees.cleanupSubtask({
              repoRoot: task.repoRoot,
              worktreePath: subtask.worktreePath,
              branchName: subtask.branchName,
            });
          }
          this.activeSubtasks.delete(subtask.subtaskId);
        }
      }

      const nextReady = this.store
        .listReadySubtasks(task.taskId)
        .filter((subtask) => subtask.status === "ready" || subtask.status === "queued");
      if (nextReady.length > 0 && activeRuns.length < Math.max(1, task.maxParallelWorkers)) {
        const subtask = nextReady[0];
        if (subtask && !this.activeSubtasks.has(subtask.subtaskId)) {
          const prepared = this.worktrees.prepareSubtask({
            taskId: task.taskId,
            subtaskId: subtask.subtaskId,
            repoRoot: task.repoRoot,
            baseRef: task.baseRef,
          });
          this.store.updateSubtask(subtask.subtaskId, {
            status: "running",
            startedAt: this.clock.now(),
            attempt: subtask.attempt + 1,
            branchName: prepared.branchName,
            worktreePath: prepared.worktreePath,
          });
          this.activeSubtasks.add(subtask.subtaskId);
          this.runner.start({
            taskId: task.taskId,
            subtaskId: subtask.subtaskId,
            cwd: prepared.worktreePath,
            prompt: subtask.prompt,
          });
        }
      }

      const refreshedSubtasks = this.store.listSubtasks(task.taskId);
      const total = refreshedSubtasks.length;
      const completed = refreshedSubtasks.filter((subtask) => subtask.status === "completed").length;
      const failed = refreshedSubtasks.find((subtask) => subtask.status === "failed");
      if (failed) {
        this.store.updateTask(task.taskId, {
          status: "failed",
          finishedAt: this.clock.now(),
          lastError: failed.lastError ?? "A worker failed.",
        });
        continue;
      }
      if (total > 0 && completed === total) {
        const summaries = refreshedSubtasks
          .map((subtask) => `- ${subtask.title}: ${subtask.resultSummary ?? "completed"}`)
          .join("\n");
        this.store.updateTask(task.taskId, {
          status: "completed",
          finishedAt: this.clock.now(),
          finalSummary: summaries,
        });
      }
    }
  }

  private refreshDependencyStates(subtasks: ReturnType<ProjectTaskStore["listSubtasks"]>): void {
    const byId = new Map(subtasks.map((subtask) => [subtask.subtaskId, subtask]));
    for (const subtask of subtasks) {
      if (
        subtask.status === "completed" ||
        subtask.status === "running" ||
        subtask.status === "failed" ||
        subtask.status === "cancelled" ||
        subtask.status === "skipped"
      ) {
        continue;
      }
      if (subtask.dependsOnSubtaskIds.length === 0) {
        if (subtask.status === "blocked") {
          this.store.updateSubtask(subtask.subtaskId, { status: "ready" });
        }
        continue;
      }
      const dependencyStates = subtask.dependsOnSubtaskIds.map((dependencyId) => byId.get(dependencyId)?.status);
      if (
        dependencyStates.some(
          (status) => status === "failed" || status === "cancelled" || status === "skipped" || status === undefined,
        )
      ) {
        this.store.updateSubtask(subtask.subtaskId, {
          status: "skipped",
          finishedAt: this.clock.now(),
          lastError: "Skipped because one or more dependencies did not complete successfully.",
        });
        continue;
      }
      if (dependencyStates.every((status) => status === "completed") && subtask.status === "blocked") {
        this.store.updateSubtask(subtask.subtaskId, { status: "ready" });
      }
    }
  }

  cancelTask(taskId: string): { cancelled: boolean; message: string } {
    const task = this.store.getTask(taskId);
    if (!task) {
      return { cancelled: false, message: "Unknown task id." };
    }
    const subtasks = this.store.listSubtasks(taskId);
    for (const subtask of subtasks) {
      if (subtask.status === "running") {
        this.runner.cancelSubtask(subtask.subtaskId);
      }
      if (subtask.status === "queued" || subtask.status === "ready" || subtask.status === "running") {
        this.store.updateSubtask(subtask.subtaskId, {
          status: "cancelled",
          finishedAt: this.clock.now(),
        });
      }
      if (subtask.worktreePath || subtask.branchName) {
        this.worktrees.cleanupSubtask({
          repoRoot: task.repoRoot,
          worktreePath: subtask.worktreePath,
          branchName: subtask.branchName,
        });
      }
      this.activeSubtasks.delete(subtask.subtaskId);
    }
    this.store.updateTask(taskId, {
      status: "cancelled",
      finishedAt: this.clock.now(),
    });
    return { cancelled: true, message: `Cancelled ${taskId}.` };
  }

  private readFinalSummary(taskId: string, subtaskId: string): { text?: string; failed: boolean } {
    const outputPath = path.join(this.config.projectTasks.artifactRoot, taskId, subtaskId, "final.md");
    if (!fs.existsSync(outputPath)) {
      return { failed: false };
    }
    const raw = fs.readFileSync(outputPath, "utf8").trim();
    if (!raw) {
      return { failed: false };
    }
    return { text: raw.slice(0, 4_000), failed: /\b(error|failed|failure)\b/i.test(raw) };
  }
}
