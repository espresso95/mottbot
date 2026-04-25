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

describe("ProjectCommandRouter", () => {
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
      db.close();
    } finally {
      removeTempDir(root);
    }
  });
});
