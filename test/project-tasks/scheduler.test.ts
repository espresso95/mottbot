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
      codex: {
        command: "codex",
        coderProfile: "mottbot-coder",
        reviewerProfile: "mottbot-reviewer",
        defaultTimeoutMs: 60_000,
      },
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
    commitAllChanges: (params: { worktreePath: string; message: string }) => { committed: boolean; output: string };
    prepareIntegration: (params: { taskId: string }) => { worktreePath: string; branchName: string };
    mergeBranch: (params: { branchName: string }) => { ok: boolean; output: string };
    diffStat: () => string;
    publishBranch: (params: {
      repoRoot: string;
      worktreePath: string;
      branchName: string;
      baseRef: string;
      targetRef?: string;
      title: string;
      body: string;
      openPullRequest?: boolean;
    }) => { pushOutput: string; pullRequestUrl?: string; pullRequestOutput?: string };
  }> = {},
) {
  return {
    prepareSubtask: ({ subtaskId }: { subtaskId: string }) => ({
      worktreePath: root,
      branchName: `mottbot/test/${subtaskId}`,
    }),
    cleanupSubtask: () => {},
    listProtectedChanges: () => [],
    commitAllChanges: () => ({ committed: false, output: "" }),
    prepareIntegration: ({ taskId }: { taskId: string }) => ({
      worktreePath: root,
      branchName: `mottbot/${taskId}/integration`,
    }),
    mergeBranch: () => ({ ok: true, output: "" }),
    diffStat: () => " README.md | 1 +",
    publishBranch: () => ({ pushOutput: "pushed" }),
    ...overrides,
  };
}

describe("ProjectTaskScheduler", () => {
  it("starts ready subtasks and queues review after integration", async () => {
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
      const subtask = store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "p",
        status: "ready",
      });
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
      expect(store.getTask(task.taskId)?.status).toBe("reviewing");
      expect(
        store.listSubtasks(task.taskId).some((entry) => entry.role === "reviewer" && entry.status === "ready"),
      ).toBe(true);
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("fails recovered interrupted running subtasks on the next tick", async () => {
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
        status: "running",
        maxParallelWorkers: 1,
        maxAttemptsPerSubtask: 1,
      });
      const subtask = store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "p",
        status: "running",
      });
      const cliRun = store.createCliRun({
        taskId: task.taskId,
        subtaskId: subtask.subtaskId,
        commandJson: "[]",
        cwd: root,
        stdoutLogPath: path.join(root, "stdout.log"),
        stderrLogPath: path.join(root, "stderr.log"),
        jsonlLogPath: path.join(root, "events.jsonl"),
      });
      store.updateCliRun(cliRun.cliRunId, { status: "streaming", startedAt: clock.now() });
      store.recoverInterruptedCliRuns("restart recovery");

      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        { start: () => "run-1", cancelSubtask: () => true } as never,
        schedulerWorktrees(root) as never,
      );
      await scheduler.tick();

      expect(store.getSubtask(subtask.subtaskId)).toMatchObject({
        status: "failed",
        lastError: "restart recovery",
      });
      expect(store.getTask(task.taskId)).toMatchObject({
        status: "failed",
        lastError: "restart recovery",
      });
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
      const subtask = store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "p",
        status: "running",
      });
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
      const first = store.createSubtask({
        taskId: task.taskId,
        title: "first",
        role: "worker",
        prompt: "first",
        status: "ready",
      });
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
      const first = store.createSubtask({
        taskId: task.taskId,
        title: "first",
        role: "worker",
        prompt: "first",
        status: "ready",
      });
      const second = store.createSubtask({
        taskId: task.taskId,
        title: "second",
        role: "worker",
        prompt: "second",
        status: "ready",
      });
      const third = store.createSubtask({
        taskId: task.taskId,
        title: "third",
        role: "worker",
        prompt: "third",
        status: "ready",
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
        store.createSubtask({
          taskId: task.taskId,
          title: `${task.title} a`,
          role: "worker",
          prompt: "a",
          status: "ready",
        });
        store.createSubtask({
          taskId: task.taskId,
          title: `${task.title} b`,
          role: "worker",
          prompt: "b",
          status: "ready",
        });
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
      store.createSubtask({
        taskId: secondTask.taskId,
        title: "second a",
        role: "worker",
        prompt: "a",
        status: "ready",
      });
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
      const finished = store.createSubtask({
        taskId: task.taskId,
        title: "done",
        role: "worker",
        prompt: "done",
        status: "running",
      });
      const active = store.createSubtask({
        taskId: task.taskId,
        title: "active",
        role: "worker",
        prompt: "active",
        status: "running",
      });
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
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
      );

      await scheduler.tick();

      expect(store.getSubtask(finished.subtaskId)?.status).toBe("completed");
      expect(store.getSubtask(active.subtaskId)?.status).toBe("running");
      expect(store.getTask(task.taskId)?.status).toBe("running");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("commits completed worker changes before merging the worker branch", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 450;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "running",
        maxParallelWorkers: 1,
        maxAttemptsPerSubtask: 1,
      });
      const worker = store.createSubtask({
        taskId: task.taskId,
        title: "add feature",
        role: "worker",
        prompt: "add feature",
        status: "running",
      });
      const workerBranch = "mottbot/test/worker";
      const workerWorktree = path.join(root, "worker");
      store.updateSubtask(worker.subtaskId, {
        branchName: workerBranch,
        worktreePath: workerWorktree,
      });
      const run = store.createCliRun({
        taskId: task.taskId,
        subtaskId: worker.subtaskId,
        commandJson: "{}",
        cwd: workerWorktree,
        stdoutLogPath: path.join(root, "worker.out"),
        stderrLogPath: path.join(root, "worker.err"),
        jsonlLogPath: path.join(root, "worker.jsonl"),
      });
      store.updateCliRun(run.cliRunId, { status: "exited", finishedAt: clock.now() });
      const events: string[] = [];
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root, {
        commitAllChanges: ({ message }) => {
          events.push(`commit:${message}`);
          return { committed: true, output: "committed" };
        },
        mergeBranch: ({ branchName }) => {
          events.push(`merge:${branchName}`);
          return { ok: true, output: "" };
        },
      });
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
      );

      await scheduler.tick();

      expect(store.getSubtask(worker.subtaskId)?.status).toBe("completed");
      expect(store.getTask(task.taskId)?.status).toBe("reviewing");
      expect(events[0]).toBe(`commit:Project ${task.taskId}: add feature`);
      expect(events).toContain(`merge:${workerBranch}`);
      expect(events.indexOf(`commit:Project ${task.taskId}: add feature`)).toBeLessThan(
        events.indexOf(`merge:${workerBranch}`),
      );
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
      const first = store.createSubtask({
        taskId: task.taskId,
        title: "first",
        role: "worker",
        prompt: "first",
        status: "completed",
      });
      const second = store.createSubtask({
        taskId: task.taskId,
        title: "second",
        role: "worker",
        prompt: "second",
        status: "completed",
      });
      store.updateSubtask(first.subtaskId, {
        branchName: "mottbot/test/first",
        worktreePath: path.join(root, "first"),
        resultSummary: "first done",
      });
      store.updateSubtask(second.subtaskId, {
        branchName: "mottbot/test/second",
        worktreePath: path.join(root, "second"),
        resultSummary: "second done",
      });
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
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
      );

      await scheduler.tick();

      const nextTask = store.getTask(task.taskId);
      expect(merged).toEqual(["mottbot/test/first", "mottbot/test/second"]);
      expect(cleanedBranches).toEqual([]);
      expect(nextTask?.status).toBe("reviewing");
      expect(nextTask?.integrationBranch).toBe(`mottbot/${task.taskId}/integration`);
      expect(nextTask?.finalDiffStat).toContain("README.md");
      expect(
        store.listSubtasks(task.taskId).some((entry) => entry.role === "reviewer" && entry.status === "ready"),
      ).toBe(true);
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
      const worker = store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "worker",
        status: "completed",
      });
      store.updateSubtask(worker.subtaskId, {
        branchName: "mottbot/test/worker",
        worktreePath: path.join(root, "worker"),
      });
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root, {
        mergeBranch: () => ({ ok: false, output: "CONFLICT (content): Merge conflict in src/file.ts" }),
      });
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
      );

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

  it("runs the integration worker in the integration worktree and queues review afterward", async () => {
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
      store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "worker",
        status: "completed",
      });
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
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
      );

      await scheduler.tick();
      expect(starts).toEqual([integrationWorktree]);
      expect(runId).toBeTruthy();

      store.updateCliRun(runId!, { status: "exited", finishedAt: clock.now() });
      await scheduler.tick();

      const nextTask = store.getTask(task.taskId);
      expect(store.getSubtask(integrator.subtaskId)?.status).toBe("completed");
      expect(nextTask?.status).toBe("reviewing");
      expect(nextTask?.integrationBranch).toBe(integrationBranch);
      expect(
        store.listSubtasks(task.taskId).some((entry) => entry.role === "reviewer" && entry.status === "ready"),
      ).toBe(true);
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("runs the reviewer in the integration worktree with the reviewer profile", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 800;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "reviewing",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const integrationBranch = `mottbot/${task.taskId}/integration`;
      const integrationWorktree = path.join(root, "integration");
      store.updateTask(task.taskId, {
        integrationBranch,
        integrationWorktreePath: integrationWorktree,
      });
      store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "worker",
        status: "completed",
      });
      const reviewer = store.createSubtask({
        taskId: task.taskId,
        title: "Review integrated result",
        role: "reviewer",
        prompt: "review",
        status: "ready",
      });
      store.updateSubtask(reviewer.subtaskId, {
        branchName: integrationBranch,
        worktreePath: integrationWorktree,
      });
      const starts: Array<{ cwd: string; profile?: string }> = [];
      const fakeRunner = {
        start: ({
          cwd,
          profile,
          taskId,
          subtaskId,
        }: {
          cwd: string;
          profile?: string;
          taskId: string;
          subtaskId: string;
        }) => {
          starts.push({ cwd, profile });
          const run = store.createCliRun({
            taskId,
            subtaskId,
            commandJson: "{}",
            cwd,
            stdoutLogPath: path.join(root, "reviewer.out"),
            stderrLogPath: path.join(root, "reviewer.err"),
            jsonlLogPath: path.join(root, "reviewer.jsonl"),
          });
          store.updateCliRun(run.cliRunId, { status: "streaming", startedAt: clock.now() });
          return run.cliRunId;
        },
        cancelSubtask: (_id: string) => true,
      };
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        schedulerWorktrees(root) as never,
      );

      await scheduler.tick();

      expect(starts).toEqual([{ cwd: integrationWorktree, profile: "mottbot-reviewer" }]);
      expect(store.getSubtask(reviewer.subtaskId)?.status).toBe("running");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("completes after reviewer success and sends a final report", async () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 900;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "reviewing",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const integrationBranch = `mottbot/${task.taskId}/integration`;
      const integrationWorktree = path.join(root, "integration");
      store.updateTask(task.taskId, {
        integrationBranch,
        integrationWorktreePath: integrationWorktree,
        finalDiffStat: " README.md | 1 +",
      });
      const worker = store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "worker",
        status: "completed",
      });
      store.updateSubtask(worker.subtaskId, {
        branchName: "mottbot/test/worker",
        worktreePath: path.join(root, "worker"),
        resultSummary: "worker done",
      });
      const reviewer = store.createSubtask({
        taskId: task.taskId,
        title: "Review integrated result",
        role: "reviewer",
        prompt: "review",
        status: "running",
      });
      store.updateSubtask(reviewer.subtaskId, {
        branchName: integrationBranch,
        worktreePath: integrationWorktree,
      });
      const run = store.createCliRun({
        taskId: task.taskId,
        subtaskId: reviewer.subtaskId,
        commandJson: "{}",
        cwd: integrationWorktree,
        stdoutLogPath: path.join(root, "reviewer.out"),
        stderrLogPath: path.join(root, "reviewer.err"),
        jsonlLogPath: path.join(root, "reviewer.jsonl"),
      });
      store.updateCliRun(run.cliRunId, { status: "exited", finishedAt: clock.now() });
      const finalDir = path.join(root, "artifacts", task.taskId, reviewer.subtaskId);
      const reviewText = [
        "No blocking issues found.",
        "",
        "The integrated result is ready for operator review.",
        "Validation passed with `corepack pnpm test`: 4 tests passed, 0 failed.",
      ].join("\n");
      await import("node:fs/promises").then(async (fsPromises) => {
        await fsPromises.mkdir(finalDir, { recursive: true });
        await fsPromises.writeFile(path.join(finalDir, "final.md"), reviewText, "utf8");
      });
      const cleanedBranches: string[] = [];
      const reports: string[] = [];
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root, {
        cleanupSubtask: ({ branchName, deleteBranch }) => {
          if (branchName && deleteBranch !== false) {
            cleanedBranches.push(branchName);
          }
        },
      });
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
        ({ text }) => {
          reports.push(text);
        },
      );

      await scheduler.tick();

      const completed = store.getTask(task.taskId);
      expect(store.getSubtask(reviewer.subtaskId)?.status).toBe("completed");
      expect(completed?.status).toBe("completed");
      expect(completed?.finalBranch).toBe(integrationBranch);
      expect(completed?.finalSummary).toContain(reviewText);
      expect(cleanedBranches).toEqual(["mottbot/test/worker"]);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain("Project review passed");
      expect(reports[0]).toContain("No blocking issues found. The integrated result is ready");
      expect(reports[0]).toContain("Publish to main: /project publish PM-");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("creates publish approvals only after review completion", () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 1_000;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "completed",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const runningTask = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "running",
        originalPrompt: "prompt",
        status: "running",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const integrationBranch = `mottbot/${task.taskId}/integration`;
      store.updateTask(task.taskId, {
        finalBranch: integrationBranch,
        integrationWorktreePath: path.join(root, "integration"),
      });
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        schedulerWorktrees(root) as never,
      );

      expect(scheduler.requestPublishApproval({ taskId: runningTask.taskId }).ok).toBe(false);
      const result = scheduler.requestPublishApproval({
        taskId: task.taskId,
        requestedBy: "operator",
        openPullRequest: true,
      });

      expect(result.ok).toBe(true);
      expect(result.approvalId).toBeTruthy();
      const approval = store.getApproval(result.approvalId!);
      expect(approval?.kind).toBe("push");
      expect(approval?.requestedBy).toBe("operator");
      expect(JSON.parse(approval!.requestJson)).toEqual({ openPullRequest: true, pushToBaseRef: false });
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("expires pending project approvals before executing approval actions", () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 1_000;
      const clock: Clock = { now: () => now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "awaiting_approval",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const approval = store.createApproval({
        taskId: task.taskId,
        kind: "start_project",
        requestedBy: "operator",
        requestJson: JSON.stringify({ prompt: "ship it" }),
        expiresAt: 1_500,
      });
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        schedulerWorktrees(root) as never,
      );
      now = 1_501;

      const result = scheduler.approveApproval(approval.approvalId, "admin");

      expect(result).toEqual({
        ok: false,
        message: `Approval ${approval.approvalId} has expired.`,
      });
      expect(store.getApproval(approval.approvalId)).toMatchObject({
        status: "expired",
        decidedBy: "admin",
      });
      expect(store.getTask(task.taskId)?.status).toBe("awaiting_approval");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("publishes approved branches and records pull request output", () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 1_100;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "completed",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const integrationBranch = `mottbot/${task.taskId}/integration`;
      const integrationWorktree = path.join(root, "integration");
      store.updateTask(task.taskId, {
        finalBranch: integrationBranch,
        integrationWorktreePath: integrationWorktree,
        finalSummary: "review complete",
      });
      const approval = store.createApproval({
        taskId: task.taskId,
        kind: "push",
        requestedBy: "operator",
        requestJson: JSON.stringify({ openPullRequest: true }),
      });
      const published: Array<{
        branchName: string;
        openPullRequest?: boolean;
        baseRef: string;
        targetRef?: string;
        title: string;
      }> = [];
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root, {
        publishBranch: ({ branchName, openPullRequest, baseRef, targetRef, title }) => {
          published.push({ branchName, openPullRequest, baseRef, targetRef, title });
          return { pushOutput: "pushed", pullRequestUrl: "https://github.com/example/repo/pull/123" };
        },
      });
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
      );

      const result = scheduler.approveApproval(approval.approvalId, "admin");

      expect(result.ok).toBe(true);
      expect(published).toEqual([
        {
          branchName: integrationBranch,
          openPullRequest: true,
          baseRef: "main",
          targetRef: integrationBranch,
          title: "task",
        },
      ]);
      expect(store.getApproval(approval.approvalId)?.status).toBe("approved");
      const updatedTask = store.getTask(task.taskId);
      expect(updatedTask?.finalSummary).toContain(`Pushed branch: ${integrationBranch}`);
      expect(updatedTask?.finalSummary).toContain("https://github.com/example/repo/pull/123");
      expect(updatedTask?.lastError).toBeUndefined();
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("publishes approved branches directly to the base ref without a pull request", () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 1_150;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "completed",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const integrationBranch = `mottbot/${task.taskId}/integration`;
      const integrationWorktree = path.join(root, "integration");
      store.updateTask(task.taskId, {
        finalBranch: integrationBranch,
        integrationWorktreePath: integrationWorktree,
        finalSummary: "review complete",
      });
      const approval = store.createApproval({
        taskId: task.taskId,
        kind: "push",
        requestedBy: "operator",
        requestJson: JSON.stringify({ openPullRequest: false, pushToBaseRef: true }),
      });
      const published: Array<{
        branchName: string;
        openPullRequest?: boolean;
        baseRef: string;
        targetRef?: string;
        title: string;
      }> = [];
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root, {
        publishBranch: ({ branchName, openPullRequest, baseRef, targetRef, title }) => {
          published.push({ branchName, openPullRequest, baseRef, targetRef, title });
          return { pushOutput: "pushed" };
        },
      });
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
      );

      const result = scheduler.approveApproval(approval.approvalId, "admin");

      expect(result.ok).toBe(true);
      expect(published).toEqual([
        {
          branchName: integrationBranch,
          openPullRequest: false,
          baseRef: "main",
          targetRef: "main",
          title: "task",
        },
      ]);
      expect(result.message).toContain(`Pushed branch: ${integrationBranch} -> main`);
      expect(store.getApproval(approval.approvalId)?.status).toBe("approved");
      const updatedTask = store.getTask(task.taskId);
      expect(updatedTask?.finalSummary).toContain(`Pushed branch: ${integrationBranch} -> main`);
      expect(updatedTask?.finalSummary).not.toContain("Pull request:");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("cleans retained project worktrees and local branches for completed tasks", () => {
    const root = createTempDir();
    try {
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      let now = 1_200;
      const clock: Clock = { now: () => ++now };
      const store = new ProjectTaskStore(db, clock);
      const task = store.createTask({
        chatId: "chat",
        repoRoot: root,
        baseRef: "main",
        title: "task",
        originalPrompt: "prompt",
        status: "completed",
        maxParallelWorkers: 2,
        maxAttemptsPerSubtask: 1,
      });
      const worker = store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "prompt",
        status: "completed",
      });
      const reviewer = store.createSubtask({
        taskId: task.taskId,
        title: "reviewer",
        role: "reviewer",
        prompt: "prompt",
        status: "completed",
      });
      const integrationBranch = `mottbot/${task.taskId}/integration`;
      const integrationWorktree = path.join(root, "integration");
      const workerBranch = `mottbot/${task.taskId}/${worker.subtaskId}`;
      const workerWorktree = path.join(root, "worker");
      store.updateTask(task.taskId, {
        integrationBranch,
        integrationWorktreePath: integrationWorktree,
        finalBranch: integrationBranch,
        finalSummary: "review complete",
      });
      store.updateSubtask(worker.subtaskId, {
        branchName: workerBranch,
        worktreePath: workerWorktree,
      });
      store.updateSubtask(reviewer.subtaskId, {
        branchName: integrationBranch,
        worktreePath: integrationWorktree,
      });
      const cleaned: Array<{ worktreePath?: string; branchName?: string }> = [];
      const fakeRunner = {
        start: () => "run",
        cancelSubtask: (_id: string) => true,
      };
      const fakeWorktrees = schedulerWorktrees(root, {
        cleanupSubtask: ({ worktreePath, branchName }) => {
          cleaned.push({ worktreePath, branchName });
        },
      });
      const scheduler = new ProjectTaskScheduler(
        schedulerConfig(root),
        clock,
        store,
        fakeRunner as never,
        fakeWorktrees as never,
      );

      const result = scheduler.cleanupTask(task.taskId);

      expect(result.ok).toBe(true);
      expect(cleaned).toEqual([
        { worktreePath: integrationWorktree, branchName: integrationBranch },
        { worktreePath: workerWorktree, branchName: workerBranch },
      ]);
      const updatedTask = store.getTask(task.taskId);
      expect(updatedTask?.integrationBranch).toBeUndefined();
      expect(updatedTask?.integrationWorktreePath).toBeUndefined();
      expect(updatedTask?.finalBranch).toBe(integrationBranch);
      expect(updatedTask?.finalSummary).toContain("Cleanup:");
      expect(store.getSubtask(worker.subtaskId)?.worktreePath).toBeUndefined();
      expect(store.getSubtask(reviewer.subtaskId)?.branchName).toBeUndefined();
      expect(scheduler.cleanupTask(task.taskId).message).toContain("No retained project worktrees or local branches");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });
});
