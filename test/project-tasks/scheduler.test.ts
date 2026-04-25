import path from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { ProjectTaskStore } from "../../src/project-tasks/project-task-store.js";
import { ProjectTaskScheduler } from "../../src/project-tasks/project-task-scheduler.js";
import type { Clock } from "../../src/shared/clock.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";
import type { AppConfig } from "../../src/app/config.js";

describe("ProjectTaskScheduler", () => {
  it("starts ready subtasks and marks task complete", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 1_700_000_000_000;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "title",
        originalPrompt: "prompt",
        status: "queued",
        maxParallelWorkers: 1,
        maxAttemptsPerSubtask: 1,
      });
      const subtask = store.createSubtask({ taskId: task.taskId, title: "worker", role: "worker", prompt: "p", status: "ready" });
      const fakeRunner = {
        start: () => "run-1",
        cancelSubtask: () => true,
      };
      const fakeWorktrees = {
        prepareSubtask: () => ({ worktreePath: root, branchName: "mottbot/test/worker" }),
        cleanupSubtask: () => {},
        listProtectedChanges: () => [],
      };
      const config = {
        projectTasks: {
          enabled: true,
          artifactRoot: path.join(root, "artifacts"),
        },
      } as AppConfig;
      const scheduler = new ProjectTaskScheduler(config, clock, store, fakeRunner as never, fakeWorktrees as never);
      await scheduler.tick();
      expect(store.getSubtask(subtask.subtaskId)?.status).toBe("running");
      await scheduler.tick();
      expect(store.getTask(task.taskId)?.status).toBe("completed");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });


  it("cancels running tasks", () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 1;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "title",
        originalPrompt: "prompt",
        status: "running",
        maxParallelWorkers: 1,
        maxAttemptsPerSubtask: 1,
      });
      const subtask = store.createSubtask({ taskId: task.taskId, title: "worker", role: "worker", prompt: "p", status: "running" });
      const fakeRunner = {
        start: () => "run-1",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = {
        prepareSubtask: () => ({ worktreePath: root, branchName: "mottbot/test/worker" }),
        cleanupSubtask: () => {},
        listProtectedChanges: () => [],
      };
      const config = { projectTasks: { enabled: true, artifactRoot: path.join(root, "artifacts") } } as AppConfig;
      const scheduler = new ProjectTaskScheduler(config, clock, store, fakeRunner as never, fakeWorktrees as never);
      const result = scheduler.cancelTask(task.taskId);
      expect(result.cancelled).toBe(true);
      expect(store.getTask(task.taskId)?.status).toBe("cancelled");
      expect(store.getSubtask(subtask.subtaskId)?.status).toBe("cancelled");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });
});
