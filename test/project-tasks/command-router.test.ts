import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import type { InboundEvent } from "../../src/telegram/types.js";
import { ProjectTaskStore } from "../../src/project-tasks/project-task-store.js";
import { ProjectCommandRouter } from "../../src/project-tasks/project-command-router.js";
import type { Clock } from "../../src/shared/clock.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";
import type { AppConfig } from "../../src/app/config.js";
import { createCallbackEvent, createInboundEvent } from "../helpers/fakes.js";

type SentProjectMessage = {
  chatId: string;
  text: string;
  options: unknown;
};

function createProjectRouterFixture(
  options: {
    enabled?: boolean;
    requireApproval?: boolean;
    repoRoots?: string[];
    scheduler?: Partial<{
      cancelTask: (taskId: string) => { message: string };
      cleanupTask: (taskId: string) => { message: string };
      approveApproval: (approvalId: string, decidedBy?: string) => { message: string };
      requestPublishApproval: (params: {
        taskId: string;
        requestedBy?: string;
        openPullRequest: boolean;
        pushToBaseRef: boolean;
      }) => { message: string };
    }>;
  } = {},
) {
  const root = createTempDir();
  fs.mkdirSync(path.join(root, ".git"));
  const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
  migrateDatabase(db);
  const clock: Clock = { now: () => Date.now() };
  const store = new ProjectTaskStore(db, clock);
  const sent: SentProjectMessage[] = [];
  const api = {
    sendMessage: async (chatId: string, text: string, messageOptions: unknown) => {
      sent.push({ chatId, text, options: messageOptions });
    },
  };
  const scheduler = {
    cancelTask: (taskId: string) => ({ message: `Cancelled ${taskId}` }),
    cleanupTask: (taskId: string) => ({ message: `Cleaned ${taskId}` }),
    approveApproval: (approvalId: string) => ({ message: `Approved ${approvalId}` }),
    requestPublishApproval: () => ({ message: "Created publish approval" }),
    ...options.scheduler,
  };
  const config = {
    projectTasks: {
      enabled: options.enabled ?? true,
      repoRoots: options.repoRoots ?? [root],
      approvals: { requireBeforeProjectStart: options.requireApproval ?? false },
      defaultBaseRef: "main",
      defaultMaxParallelWorkersPerProject: 1,
    },
  } as AppConfig;
  const router = new ProjectCommandRouter(api as never, config, store, scheduler as never);
  const event = createInboundEvent({
    chatId: "chat",
    messageId: 2,
    text: "/project",
    fromUserId: "u1",
    fromUsername: "user1",
  });
  return {
    root,
    db,
    store,
    sent,
    router,
    event,
    cleanup: () => {
      db.close();
      removeTempDir(root);
    },
  };
}

describe("ProjectCommandRouter", () => {
  it("adds approval buttons and handles project approval callbacks", async () => {
    let approvedBy: string | undefined;
    const fixture = createProjectRouterFixture({
      requireApproval: true,
      scheduler: {
        approveApproval: (approvalId: string, decidedBy?: string) => {
          approvedBy = decidedBy;
          return { message: `Approved ${approvalId}` };
        },
      },
    });
    try {
      await fixture.router.handle(fixture.event, ["start", fixture.root, "ship", "it"]);
      const approvalId = fixture.db.db
        .prepare<unknown[], { approval_id: string }>("select approval_id from project_approvals limit 1")
        .get()?.approval_id;

      expect(fixture.sent.at(-1)?.options).toMatchObject({
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Approve project",
                callback_data: `mb:pa:${approvalId}`,
              },
            ],
          ],
        },
      });

      await fixture.router.handleApprovalCallback(
        createCallbackEvent({ fromUserId: "admin-1", data: `mb:pa:${approvalId}` }),
        approvalId!,
      );

      expect(approvedBy).toBe("admin-1");
      expect(fixture.sent.at(-1)?.text).toContain(`Approved ${approvalId}`);
    } finally {
      fixture.cleanup();
    }
  });

  it("creates approval-gated tasks and allows approval", async () => {
    const root = createTempDir();
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      const clock: Clock = { now: () => Date.now() };
      const store = new ProjectTaskStore(db, clock);
      const sent: string[] = [];
      const api = {
        sendMessage: async (_chatId: string, text: string) => {
          sent.push(text);
        },
      };
      const scheduler = {
        cancelTask: (taskId: string) => ({ cancelled: true, message: `Cancelled ${taskId}` }),
        cleanupTask: () => ({ ok: false, message: "not used" }),
        approveApproval: (approvalId: string, decidedBy?: string) => {
          const approval = store.getApproval(approvalId);
          if (!approval) {
            return { ok: false, message: `Unknown approval ${approvalId}.` };
          }
          store.decideApproval(approval.approvalId, { status: "approved", decidedBy });
          store.updateTask(approval.taskId, { status: "queued" });
          return { ok: true, message: `Approved ${approvalId}. Task ${approval.taskId} queued.` };
        },
        requestPublishApproval: () => ({ ok: false, message: "not used" }),
      };
      const config = {
        projectTasks: {
          enabled: true,
          repoRoots: [root],
          approvals: { requireBeforeProjectStart: true },
          defaultBaseRef: "main",
          defaultMaxParallelWorkersPerProject: 1,
        },
      } as AppConfig;
      const router = new ProjectCommandRouter(api as never, config, store, scheduler as never);
      const event: InboundEvent = {
        updateId: 1,
        chatId: "chat",
        chatType: "private",
        messageId: 2,
        text: "/project",
        fromUserId: "u1",
      };

      await router.handle(event, ["start", root, "build", "thing"]);
      expect(sent.at(-1)).toContain("Awaiting approval");
      const task = store.listTasksByChat("chat", 1)[0];
      expect(task?.status).toBe("awaiting_approval");
      const approvalId = db.db
        .prepare<unknown[], { approval_id: string }>("select approval_id from project_approvals limit 1")
        .get()?.approval_id;
      expect(approvalId).toBeTruthy();

      await router.handle(event, ["approve", approvalId!]);
      expect(store.getTask(task!.taskId)?.status).toBe("queued");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("handles status and cancel commands", async () => {
    const root = createTempDir();
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      const clock: Clock = { now: () => Date.now() };
      const store = new ProjectTaskStore(db, clock);
      const sent: string[] = [];
      const api = {
        sendMessage: async (_chatId: string, text: string) => {
          sent.push(text);
        },
      };
      const scheduler = {
        cancelTask: () => ({ cancelled: true, message: "Cancelled" }),
        cleanupTask: () => ({ ok: true, message: "Cleaned" }),
        approveApproval: () => ({ ok: false, message: "not used" }),
        requestPublishApproval: () => ({ ok: false, message: "not used" }),
      };
      const config = {
        projectTasks: {
          enabled: true,
          repoRoots: [root],
          approvals: { requireBeforeProjectStart: false },
          defaultBaseRef: "main",
          defaultMaxParallelWorkersPerProject: 1,
        },
      } as AppConfig;
      const router = new ProjectCommandRouter(api as never, config, store, scheduler as never);
      const event: InboundEvent = {
        updateId: 1,
        chatId: "chat",
        chatType: "private",
        messageId: 2,
        text: "/project",
      };
      await router.handle(event, ["status"]);
      expect(sent.at(-1)).toContain("No project tasks found");
      await router.handle(event, ["start", root, "ship", "it"]);
      const task = store.listTasksByChat("chat", 1)[0];
      expect(task).toBeTruthy();
      await router.handle(event, ["status", task!.taskId]);
      expect(sent.at(-1)).toContain("Task ID");
      await router.handle(event, ["cancel", task!.taskId]);
      expect(sent.at(-1)).toContain("Cancelled");
      await router.handle(event, ["cleanup", task!.taskId]);
      expect(sent.at(-1)).toContain("Cleaned");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("creates publish approvals with optional pull requests", async () => {
    const root = createTempDir();
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const db = new DatabaseClient(path.join(root, "mottbot.sqlite"));
      migrateDatabase(db);
      const clock: Clock = { now: () => Date.now() };
      const store = new ProjectTaskStore(db, clock);
      const sent: string[] = [];
      const api = {
        sendMessage: async (_chatId: string, text: string) => {
          sent.push(text);
        },
      };
      let publishArgs:
        | { taskId: string; requestedBy?: string; openPullRequest?: boolean; pushToBaseRef?: boolean }
        | undefined;
      const scheduler = {
        cancelTask: () => ({ cancelled: true, message: "Cancelled" }),
        cleanupTask: () => ({ ok: false, message: "not used" }),
        approveApproval: () => ({ ok: false, message: "not used" }),
        requestPublishApproval: (params: {
          taskId: string;
          requestedBy?: string;
          openPullRequest?: boolean;
          pushToBaseRef?: boolean;
        }) => {
          publishArgs = params;
          return { ok: true, approvalId: "approval-1", message: "Created publish approval approval-1" };
        },
      };
      const config = {
        projectTasks: {
          enabled: true,
          repoRoots: [root],
          approvals: { requireBeforeProjectStart: false },
          defaultBaseRef: "main",
          defaultMaxParallelWorkersPerProject: 1,
        },
      } as AppConfig;
      const router = new ProjectCommandRouter(api as never, config, store, scheduler as never);
      const event: InboundEvent = {
        updateId: 1,
        chatId: "chat",
        chatType: "private",
        messageId: 2,
        text: "/project",
        fromUserId: "u1",
      };

      await router.handle(event, ["publish", "task-1", "pr"]);

      expect(publishArgs).toEqual({
        taskId: "task-1",
        requestedBy: "u1",
        openPullRequest: true,
        pushToBaseRef: false,
      });
      expect(sent.at(-1)).toContain("Created publish approval");

      await router.handle(event, ["publish", "task-1", "main"]);

      expect(publishArgs).toEqual({
        taskId: "task-1",
        requestedBy: "u1",
        openPullRequest: false,
        pushToBaseRef: true,
      });

      await router.handle(event, ["publish", "task-1", "main", "pr"]);

      expect(sent.at(-1)).toContain("Choose either main or pr");

      await router.handle(event, ["publish"]);

      expect(sent.at(-1)).toContain("Usage: /project publish");

      await router.handle(event, ["publish", "task-1", "unknown"]);

      expect(sent.at(-1)).toContain("Unknown publish option unknown");
      db.close();
    } finally {
      removeTempDir(root);
    }
  });

  it("reports disabled mode, unknown commands, and invalid start inputs", async () => {
    const disabled = createProjectRouterFixture({ enabled: false });
    try {
      await disabled.router.handle({ ...disabled.event, threadId: 99 }, ["status"]);

      expect(disabled.sent.at(-1)?.text).toBe("Project mode is disabled.");
      expect(disabled.sent.at(-1)?.options).toMatchObject({
        message_thread_id: 99,
        reply_parameters: { message_id: 2 },
      });
    } finally {
      disabled.cleanup();
    }

    const fixture = createProjectRouterFixture();
    const outsideRoot = createTempDir();
    try {
      await fixture.router.handle(fixture.event, ["unknown"]);
      expect(fixture.sent.at(-1)?.text).toContain("Usage: /project start");

      await fixture.router.handle(fixture.event, ["start", fixture.root]);
      expect(fixture.sent.at(-1)?.text).toBe("Usage: /project start <repo> <task>");

      await fixture.router.handle(fixture.event, ["start", outsideRoot, "ship", "it"]);
      expect(fixture.sent.at(-1)?.text).toBe("Repo path is outside allowed project roots.");

      const repoWithoutGit = path.join(fixture.root, "repo-without-git");
      fs.mkdirSync(repoWithoutGit);
      await fixture.router.handle(fixture.event, ["start", repoWithoutGit, "ship", "it"]);
      expect(fixture.sent.at(-1)?.text).toBe("Repo path must point to a git checkout.");
    } finally {
      removeTempDir(outsideRoot);
      fixture.cleanup();
    }
  });

  it("shows completed task publish details and tails active worker events", async () => {
    const fixture = createProjectRouterFixture();
    try {
      const task = fixture.store.createTask({
        chatId: fixture.event.chatId,
        requestedByUserId: fixture.event.fromUserId,
        repoRoot: fixture.root,
        baseRef: "main",
        title: "ship project",
        originalPrompt: "ship project",
        status: "running",
        maxParallelWorkers: 1,
        maxAttemptsPerSubtask: 2,
      });
      const dependency = fixture.store.createSubtask({
        taskId: task.taskId,
        title: "dependency",
        role: "worker",
        prompt: "dependency",
        status: "completed",
      });
      const subtask = fixture.store.createSubtask({
        taskId: task.taskId,
        title: "worker",
        role: "worker",
        prompt: "worker",
        dependsOnSubtaskIds: [dependency.subtaskId],
        status: "ready",
      });
      fixture.store.updateTask(task.taskId, {
        status: "completed",
        finalBranch: "mottbot/task-1/integration",
        integrationWorktreePath: path.join(fixture.root, "integration"),
        finalDiffStat: "1 file changed",
        finalSummary: "Completed cleanly",
        lastError: "Older retry failed",
      });

      await fixture.router.handle(fixture.event, ["status", task.taskId]);

      expect(fixture.sent.at(-1)?.text).toContain("Final branch: mottbot/task-1/integration");
      expect(fixture.sent.at(-1)?.text).toContain("depends on");
      expect(fixture.sent.at(-1)?.text).toContain("Diff stat:");
      expect(fixture.sent.at(-1)?.text).toContain("Publish: /project publish");
      expect(fixture.sent.at(-1)?.text).toContain("Cleanup: /project cleanup");
      expect(fixture.sent.at(-1)?.text).toContain("Last error:");

      await fixture.router.handle(fixture.event, ["tail"]);
      expect(fixture.sent.at(-1)?.text).toBe("Usage: /project tail <subtask-id>");

      await fixture.router.handle(fixture.event, ["tail", "missing-subtask"]);
      expect(fixture.sent.at(-1)?.text).toBe("Unknown subtask missing-subtask.");

      await fixture.router.handle(fixture.event, ["tail", subtask.subtaskId]);
      expect(fixture.sent.at(-1)?.text).toContain(`No active codex run for ${subtask.subtaskId}.`);

      const run = fixture.store.createCliRun({
        taskId: task.taskId,
        subtaskId: subtask.subtaskId,
        commandJson: JSON.stringify(["codex", "exec"]),
        cwd: fixture.root,
        stdoutLogPath: path.join(fixture.root, "stdout.log"),
        stderrLogPath: path.join(fixture.root, "stderr.log"),
        jsonlLogPath: path.join(fixture.root, "events.jsonl"),
      });
      fixture.store.updateCliRun(run.cliRunId, { status: "streaming", startedAt: Date.now() });
      fixture.store.addCliEvent({
        cliRunId: run.cliRunId,
        eventIndex: 1,
        eventType: "message",
        eventJson: JSON.stringify({ text: "worker started" }),
      });
      fixture.store.addCliEvent({
        cliRunId: run.cliRunId,
        eventIndex: 2,
        eventJson: JSON.stringify({ message: "worker update" }),
      });

      await fixture.router.handle(fixture.event, ["tail", subtask.subtaskId]);

      expect(fixture.sent.at(-1)?.text).toContain("Subtask: worker");
      expect(fixture.sent.at(-1)?.text).toContain("#1 message: worker started");
      expect(fixture.sent.at(-1)?.text).toContain("#2 event: worker update");
    } finally {
      fixture.cleanup();
    }
  });
});
