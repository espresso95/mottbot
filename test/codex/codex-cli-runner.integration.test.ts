import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { CodexCliRunner } from "../../src/codex-cli/codex-cli-runner.js";
import { ProjectTaskStore } from "../../src/project-tasks/project-task-store.js";
import type { Clock } from "../../src/shared/clock.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

describe("CodexCliRunner", () => {
  it("streams jsonl events and records successful exit", async () => {
    const root = createTempDir();
    const artifactRoot = path.join(root, "artifacts");
    const cliPath = path.join(root, "fake-codex.js");
    fs.writeFileSync(
      cliPath,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({type:'thread.started',thread_id:'t1'}));",
        "console.log(JSON.stringify({type:'turn.completed',text:'done'}));",
        "process.stderr.write('warn');",
      ].join("\n"),
      { mode: 0o755 },
    );

    const database = new DatabaseClient(path.join(root, "mottbot.sqlite"));
    migrateDatabase(database);
    const clock: Clock = { now: () => Date.now() };
    const store = new ProjectTaskStore(database, clock);
    const task = store.createTask({
      chatId: "chat",
      repoRoot: root,
      baseRef: "main",
      title: "t",
      originalPrompt: "p",
      status: "queued",
      maxParallelWorkers: 1,
      maxAttemptsPerSubtask: 1,
    });
    const subtask = store.createSubtask({
      taskId: task.taskId,
      title: "worker",
      role: "worker",
      prompt: "hello",
      status: "ready",
    });

    const runner = new CodexCliRunner(store, clock, {
      command: cliPath,
      coderProfile: "mottbot-coder",
      defaultTimeoutMs: 5_000,
      artifactRoot,
    });

    runner.start({
      taskId: task.taskId,
      subtaskId: subtask.subtaskId,
      cwd: root,
      prompt: "test prompt",
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    const run = store.listActiveCliRuns(task.taskId)[0];
    if (run) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const allEvents = database.db
      .prepare<
        unknown[],
        { cli_run_id: string; status: string }
      >("select cli_run_id, status from codex_cli_runs order by updated_at desc")
      .all();
    expect(allEvents.length).toBeGreaterThan(0);
    expect(allEvents[0]?.status).toBe("exited");

    const runId = allEvents[0]?.cli_run_id;
    expect(runId).toBeTruthy();
    const events = store.listCliEvents(runId!, 10);
    expect(events.length).toBeGreaterThanOrEqual(2);

    database.close();
    removeTempDir(root);
  });
});
