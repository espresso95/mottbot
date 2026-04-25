import path from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { ProjectTaskStore } from "../../src/project-tasks/project-task-store.js";
import { ProjectTaskScheduler } from "../../src/project-tasks/project-task-scheduler.js";
import type { Clock } from "../../src/shared/clock.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";
import type { AppConfig } from "../../src/app/config.js";

function schedulerConfig(root: string, overrides: Partial<AppConfig["projectTasks"]> = {}): AppConfig {
  return {
    projectTasks: {
      enabled: true,
      artifactRoot: path.join(root, "artifacts"),
      maxConcurrentProjects: 1,
      hardMaxParallelWorkersPerProject: 2,
      maxConcurrentCodexWorkersGlobal: 2,
      ...overrides,
    },
  } as AppConfig;
}

function schedulerWorktrees(
  root: string,
  overrides: Partial<{
    prepareSubtask: (params: { subtaskId: string }) => { worktreePath: string; branchName: string };
    cleanupSubtask: (params: { worktreePath?: string; branchName?: string; deleteBranch?: boolean }) => void;
    listProtectedChanges: (worktreePath: string) => string[];
    prepareIntegration: (params: { taskId: string }) => { worktreePath: string; branchName: string };
    mergeBranch: (params: { branchName: string }) => { ok: boolean; output: string };
    diffStat: () => string;
  }> = {},
) {
  return {
    prepareSubtask: ({ subtaskId }: { subtaskId: string }) => ({ worktreePath: root, branchName: `mottbot/test/${subtaskId}` }),
    cleanupSubtask: () => {},
    listProtectedChanges: () => [],
    prepareIntegration: ({ taskId }: { taskId: string }) => ({ worktreePath: root, branchName: `mottbot/${taskId}/integration` }),
    mergeBranch: () => ({ ok: true, output: "" }),
    diffStat: () => " README.md | 1 +",
    ...overrides,
  };
}

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
      const fakeWorktrees = schedulerWorktrees(root);
      const config = schedulerConfig(root);
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
      const fakeWorktrees = schedulerWorktrees(root);
      const config = schedulerConfig(root);
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

  it("gates blocked subtasks on dependency completion", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 10;
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
      const first = store.createSubtask({ taskId: task.taskId, title: "first", role: "worker", prompt: "first", status: "ready" });
      const second = store.createSubtask({
        taskId: task.taskId,
        title: "second",
        role: "worker",
        prompt: "second",
        status: "blocked",
        dependsOnSubtaskIds: [first.subtaskId],
      });
      const starts: string[] = [];
      const fakeRunner = {
        start: ({ subtaskId }: { subtaskId: string }) => {
          starts.push(subtaskId);
          return `run-${subtaskId}`;
        },
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root);
      const config = schedulerConfig(root);
      const scheduler = new ProjectTaskScheduler(config, clock, store, fakeRunner as never, fakeWorktrees as never);

      await scheduler.tick();
      expect(starts).toEqual([first.subtaskId]);
      expect(store.getSubtask(second.subtaskId)?.status).toBe("blocked");

      store.updateSubtask(first.subtaskId, { status: "completed", finishedAt: clock.now(), resultSummary: "done" });
      await scheduler.tick();
      expect(store.getSubtask(second.subtaskId)?.status).toBe("running");
      expect(starts).toEqual([first.subtaskId, second.subtaskId]);

      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("starts multiple ready subtasks up to the per-project limit", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 100;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "title",
        originalPrompt: "prompt",
        status: "queued",
        maxParallelWorkers: 3,
        maxAttemptsPerSubtask: 1,
      });
      const first = store.createSubtask({ taskId: task.taskId, title: "first", role: "worker", prompt: "first", status: "ready" });
      const second = store.createSubtask({ taskId: task.taskId, title: "second", role: "worker", prompt: "second", status: "ready" });
      const third = store.createSubtask({ taskId: task.taskId, title: "third", role: "worker", prompt: "third", status: "ready" });
      const starts: string[] = [];
      const fakeRunner = {
        start: ({ subtaskId }: { subtaskId: string }) => {
          starts.push(subtaskId);
          return `run-${subtaskId}`;
        },
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root);
      const config = schedulerConfig(root, {
        hardMaxParallelWorkersPerProject: 2,
        maxConcurrentCodexWorkersGlobal: 10,
      });
      const scheduler = new ProjectTaskScheduler(config, clock, store, fakeRunner as never, fakeWorktrees as never);

      await scheduler.tick();

      expect(starts).toEqual([first.subtaskId, second.subtaskId]);
      expect(store.getSubtask(first.subtaskId)?.status).toBe("running");
      expect(store.getSubtask(second.subtaskId)?.status).toBe("running");
      expect(store.getSubtask(third.subtaskId)?.status).toBe("ready");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("respects the global worker limit across active projects", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 200;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const firstTask = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "first task",
        originalPrompt: "prompt",
        status: "queued",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const secondTask = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "second task",
        originalPrompt: "prompt",
        status: "queued",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      for (const task of [firstTask, secondTask]) {
        store.createSubtask({ taskId: task.taskId, title: `${task.title} a`, role: "worker", prompt: "a", status: "ready" });
        store.createSubtask({ taskId: task.taskId, title: `${task.title} b`, role: "worker", prompt: "b", status: "ready" });
      }
      const starts: Array<{ taskId: string; subtaskId: string }> = [];
      const fakeRunner = {
        start: ({ taskId, subtaskId }: { taskId: string; subtaskId: string }) => {
          starts.push({ taskId, subtaskId });
          return `run-${subtaskId}`;
        },
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root);
      const config = schedulerConfig(root, {
        maxConcurrentProjects: 2,
        hardMaxParallelWorkersPerProject: 2,
        maxConcurrentCodexWorkersGlobal: 3,
      });
      const scheduler = new ProjectTaskScheduler(config, clock, store, fakeRunner as never, fakeWorktrees as never);

      await scheduler.tick();

      expect(starts).toHaveLength(3);
      expect(starts.filter((entry) => entry.taskId === firstTask.taskId)).toHaveLength(2);
      expect(starts.filter((entry) => entry.taskId === secondTask.taskId)).toHaveLength(1);
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("respects the active project limit", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 300;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const firstTask = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "first task",
        originalPrompt: "prompt",
        status: "queued",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const secondTask = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "second task",
        originalPrompt: "prompt",
        status: "queued",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      store.createSubtask({ taskId: firstTask.taskId, title: "first a", role: "worker", prompt: "a", status: "ready" });
      store.createSubtask({ taskId: secondTask.taskId, title: "second a", role: "worker", prompt: "a", status: "ready" });
      const starts: string[] = [];
      const fakeRunner = {
        start: ({ taskId }: { taskId: string }) => {
          starts.push(taskId);
          return `run-${taskId}`;
        },
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root);
      const config = schedulerConfig(root, {
        maxConcurrentProjects: 1,
        hardMaxParallelWorkersPerProject: 2,
        maxConcurrentCodexWorkersGlobal: 4,
      });
      const scheduler = new ProjectTaskScheduler(config, clock, store, fakeRunner as never, fakeWorktrees as never);

      await scheduler.tick();

      expect(starts).toEqual([firstTask.taskId]);
      expect(store.getTask(secondTask.taskId)?.status).toBe("queued");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("finishes terminal subtasks while sibling workers are still active", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 400;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "running",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const finished = store.createSubtask({ taskId: task.taskId, title: "done", role: "worker", prompt: "done", status: "running" });
      const active = store.createSubtask({ taskId: task.taskId, title: "active", role: "worker", prompt: "active", status: "running" });
      const finishedRun = store.createCliRun({
        taskId: task.taskId,
        subtaskId: finished.subtaskId,
        commandJson: "{}",
        cwd: root,
        stdoutLogPath: path.join(root, "finished.out"),
        stderrLogPath: path.join(root, "finished.err"),
        jsonlLogPath: path.join(root, "finished.jsonl"),
      });
      store.updateCliRun(finishedRun.cliRunId, { status: "exited", finishedAt: clock.now() });
      const activeRun = store.createCliRun({
        taskId: task.taskId,
        subtaskId: active.subtaskId,
        commandJson: "{}",
        cwd: root,
        stdoutLogPath: path.join(root, "active.out"),
        stderrLogPath: path.join(root, "active.err"),
        jsonlLogPath: path.join(root, "active.jsonl"),
      });
      store.updateCliRun(activeRun.cliRunId, { status: "streaming", startedAt: clock.now() });
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root);
      const scheduler = new ProjectTaskScheduler(schedulerConfig(root), clock, store, fakeRunner as never, fakeWorktrees as never);

      await scheduler.tick();

      expect(store.getSubtask(finished.subtaskId)?.status).toBe("completed");
      expect(store.getSubtask(active.subtaskId)?.status).toBe("running");
      expect(store.getTask(task.taskId)?.status).toBe("running");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("creates an integration branch and merges completed worker branches", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 500;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "running",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const first = store.createSubtask({ taskId: task.taskId, title: "first", role: "worker", prompt: "first", status: "completed" });
      const second = store.createSubtask({ taskId: task.taskId, title: "second", role: "worker", prompt: "second", status: "completed" });
      store.updateSubtask(first.subtaskId, { branchName: "mottbot/test/first", worktreePath: path.join(root, "first"), resultSummary: "first done" });
      store.updateSubtask(second.subtaskId, { branchName: "mottbot/test/second", worktreePath: path.join(root, "second"), resultSummary: "second done" });
      const merged: string[] = [];
      const cleanedBranches: string[] = [];
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root, {
        mergeBranch: ({ branchName }) => {
          merged.push(branchName);
          return { ok: true, output: "" };
        },
        cleanupSubtask: ({ branchName, deleteBranch }) => {
          if (branchName && deleteBranch !== false) {
            cleanedBranches.push(branchName);
          }
        },
      });
      const scheduler = new ProjectTaskScheduler(schedulerConfig(root), clock, store, fakeRunner as never, fakeWorktrees as never);

      await scheduler.tick();

      const nextTask = store.getTask(task.taskId);
      expect(merged).toEqual(["mottbot/test/first", "mottbot/test/second"]);
      expect(cleanedBranches).toEqual(["mottbot/test/first", "mottbot/test/second"]);
      expect(nextTask?.status).toBe("completed");
      expect(nextTask?.finalBranch).toBe(`mottbot/${task.taskId}/integration`);
      expect(nextTask?.finalDiffStat).toContain("README.md");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("queues an integration worker when a worker branch merge conflicts", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 600;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "running",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const worker = store.createSubtask({ taskId: task.taskId, title: "worker", role: "worker", prompt: "worker", status: "completed" });
      store.updateSubtask(worker.subtaskId, { branchName: "mottbot/test/worker", worktreePath: path.join(root, "worker") });
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root, {
        mergeBranch: () => ({ ok: false, output: "CONFLICT (content): Merge conflict in src/file.ts" }),
      });
      const scheduler = new ProjectTaskScheduler(schedulerConfig(root), clock, store, fakeRunner as never, fakeWorktrees as never);

      await scheduler.tick();

      const nextTask = store.getTask(task.taskId);
      const integrator = store.listSubtasks(task.taskId).find((subtask) => subtask.role === "integrator");
      expect(nextTask?.status).toBe("integrating");
      expect(nextTask?.lastError).toContain("Integration conflict");
      expect(integrator?.status).toBe("ready");
      expect(integrator?.worktreePath).toBe(root);
      expect(integrator?.branchName).toBe(`mottbot/${task.taskId}/integration`);
      expect(integrator?.prompt).toContain("Merge conflict");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("runs the integration worker in the integration worktree and completes afterward", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 700;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "integrating",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const integrationBranch = `mottbot/${task.taskId}/integration`;
      const integrationWorktree = path.join(root, "integration");
      store.updateTask(task.taskId, {
        integrationBranch,
        integrationWorktreePath: integrationWorktree,
      });
      store.createSubtask({ taskId: task.taskId, title: "worker", role: "worker", prompt: "worker", status: "completed" });
      const integrator = store.createSubtask({
        taskId: task.taskId,
        title: "Resolve integration conflicts",
        role: "integrator",
        prompt: "resolve",
        status: "ready",
      });
      store.updateSubtask(integrator.subtaskId, {
        branchName: integrationBranch,
        worktreePath: integrationWorktree,
      });
      let runId: string | undefined;
      const starts: string[] = [];
      const fakeRunner = {
        start: ({ cwd, taskId, subtaskId }: { cwd: string; taskId: string; subtaskId: string }) => {
          starts.push(cwd);
          const run = store.createCliRun({
            taskId,
            subtaskId,
            commandJson: "{}",
            cwd,
            stdoutLogPath: path.join(root, "integrator.out"),
            stderrLogPath: path.join(root, "integrator.err"),
            jsonlLogPath: path.join(root, "integrator.jsonl"),
          });
          store.updateCliRun(run.cliRunId, { status: "streaming", startedAt: clock.now() });
          runId = run.cliRunId;
          return run.cliRunId;
        },
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root);
      const scheduler = new ProjectTaskScheduler(schedulerConfig(root), clock, store, fakeRunner as never, fakeWorktrees as never);

      await scheduler.tick();
      expect(starts).toEqual([integrationWorktree]);
      expect(runId).toBeTruthy();

      store.updateCliRun(runId!, { status: "exited", finishedAt: clock.now() });
      await scheduler.tick();
      await scheduler.tick();

      const nextTask = store.getTask(task.taskId);
      expect(store.getSubtask(integrator.subtaskId)?.status).toBe("completed");
      expect(nextTask?.status).toBe("completed");
      expect(nextTask?.finalBranch).toBe(integrationBranch);
      db.close();
    } finally {
      removeTempDir(root);
    }
  });
});
