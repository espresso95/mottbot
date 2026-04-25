import path from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { ProjectTaskStore } from "../../src/project-tasks/project-task-store.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";
import type { Clock } from "../../src/shared/clock.js";

describe("ProjectTaskStore", () => {
  it("creates tasks, subtasks, approvals and snapshots", () => {
    const root = createTempDir();
    try {
      const sqlitePath = path.join(root, "mottbot.sqlite");
      const database = new DatabaseClient(sqlitePath);
      migrateDatabase(database);
      const clock: Clock = { now: () => 1_700_000_000_000 };
      const store = new ProjectTaskStore(database, clock);

      const task = store.createTask({
        chatId: "chat-1",
        repoRoot: root,
        baseRef: "main",
        title: "test task",
        originalPrompt: "build a thing",
        planJson: '{"steps":[{"stepId":"step-1"}]}',
        status: "awaiting_approval",
        maxParallelWorkers: 1,
        maxAttemptsPerSubtask: 2,
      });
      const subtask = store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "do work",
        dependsOnSubtaskIds: ["dep-1"],
        status: "ready",
      });
      const approval = store.createApproval({
        taskId: task.taskId,
        requestJson: "{}",
      });
      const publishApproval = store.createApproval({
        taskId: task.taskId,
        kind: "push",
        requestJson: '{"openPullRequest":true}',
      });

      expect(store.getTask(task.taskId)?.status).toBe("awaiting_approval");
      expect(store.getTask(task.taskId)?.planJson).toContain("step-1");
      expect(store.listReadySubtasks(task.taskId)).toHaveLength(1);
      expect(store.getSubtask(subtask.subtaskId)?.dependsOnSubtaskIds).toEqual(["dep-1"]);
      expect(store.getApproval(approval.approvalId)?.status).toBe("pending");
      expect(store.getApproval(publishApproval.approvalId)?.kind).toBe("push");

      store.updateTask(task.taskId, { status: "queued" });
      store.updateSubtask(subtask.subtaskId, { status: "running" });
      store.decideApproval(approval.approvalId, { status: "approved" });

      const snapshot = store.projectSnapshot(task.taskId);
      expect(snapshot?.task.status).toBe("queued");
      expect(snapshot?.subtasks[0]?.status).toBe("running");
      expect(store.getApproval(approval.approvalId)?.status).toBe("approved");
      database.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("recovers active CLI runs as failed after a process restart", () => {
    const root = createTempDir();
    try {
      const sqlitePath = path.join(root, "mottbot.sqlite");
      const database = new DatabaseClient(sqlitePath);
      migrateDatabase(database);
      const clock: Clock = { now: () => 1_700_000_000_000 };
      const store = new ProjectTaskStore(database, clock);
      const task = store.createTask({
        chatId: "chat-1",
        repoRoot: root,
        baseRef: "main",
        title: "test task",
        originalPrompt: "build a thing",
        status: "running",
        maxParallelWorkers: 1,
        maxAttemptsPerSubtask: 1,
      });
      const subtask = store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "do work",
        status: "running",
      });
      const run = store.createCliRun({
        taskId: task.taskId,
        subtaskId: subtask.subtaskId,
        commandJson: "[]",
        cwd: root,
        stdoutLogPath: path.join(root, "stdout.log"),
        stderrLogPath: path.join(root, "stderr.log"),
        jsonlLogPath: path.join(root, "events.jsonl"),
      });
      store.updateCliRun(run.cliRunId, { status: "streaming", startedAt: clock.now() });

      expect(store.countActiveCliRuns()).toBe(1);
      expect(store.recoverInterruptedCliRuns("restart recovery")).toBe(1);

      const recovered = store.getLatestCliRunForSubtask(subtask.subtaskId);
      expect(store.countActiveCliRuns()).toBe(0);
      expect(recovered).toMatchObject({
        status: "failed",
        finishedAt: clock.now(),
        lastError: "restart recovery",
      });
      database.close();
    } finally {
      removeTempDir(root);
    }
  });
});
