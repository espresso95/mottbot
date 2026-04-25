import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../app/config.js";
import type { Clock } from "../shared/clock.js";
import type { CodexCliRunner } from "../codex-cli/codex-cli-runner.js";
import type { ProjectTaskStore } from "./project-task-store.js";

export class ProjectTaskScheduler {
  private timer?: NodeJS.Timeout;
  private readonly activeSubtasks = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly store: ProjectTaskStore,
    private readonly runner: CodexCliRunner,
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
      const runningSubtasks = subtasks.filter((subtask) => subtask.status === "running");
      const activeRuns = this.store.listActiveCliRuns(task.taskId);
      if (runningSubtasks.length > 0 && activeRuns.length === 0) {
        for (const subtask of runningSubtasks) {
          const finalSummary = this.readFinalSummary(task.taskId, subtask.subtaskId);
          this.store.updateSubtask(subtask.subtaskId, {
            status: finalSummary.failed ? "failed" : "completed",
            finishedAt: this.clock.now(),
            ...(finalSummary.text ? { resultSummary: finalSummary.text } : {}),
            ...(finalSummary.failed ? { lastError: finalSummary.text || "Worker failed" } : {}),
          });
          this.activeSubtasks.delete(subtask.subtaskId);
        }
      }

      const nextReady = this.store
        .listReadySubtasks(task.taskId)
        .filter((subtask) => subtask.status === "ready" || subtask.status === "queued");
      if (nextReady.length > 0 && activeRuns.length < Math.max(1, task.maxParallelWorkers)) {
        const subtask = nextReady[0];
        if (subtask && !this.activeSubtasks.has(subtask.subtaskId)) {
          this.store.updateSubtask(subtask.subtaskId, {
            status: "running",
            startedAt: this.clock.now(),
            attempt: subtask.attempt + 1,
          });
          this.activeSubtasks.add(subtask.subtaskId);
          this.runner.start({
            taskId: task.taskId,
            subtaskId: subtask.subtaskId,
            cwd: task.repoRoot,
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
