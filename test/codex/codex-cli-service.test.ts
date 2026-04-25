import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexCliService,
  type CodexCliEventRecord,
  type CodexCliFinishedPatch,
} from "../../src/codex-cli/codex-cli-service.js";
import type { Clock } from "../../src/shared/clock.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

describe("CodexCliService", () => {
  it("runs codex exec, records logs, and reports parsed events", async () => {
    const root = createTempDir();
    try {
      const cliPath = path.join(root, "fake-codex.js");
      fs.writeFileSync(
        cliPath,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "const outputIndex = process.argv.indexOf('--output-last-message');",
          "if (outputIndex !== -1) fs.writeFileSync(process.argv[outputIndex + 1], 'final answer');",
          "console.log(JSON.stringify({ type: 'thread.started', text: 'started' }));",
          "console.log(JSON.stringify({ type: 'turn.completed', message: 'done' }));",
          "process.stderr.write('warn');",
        ].join("\n"),
        { mode: 0o755 },
      );
      const clock: Clock = { now: () => Date.now() };
      const service = new CodexCliService(clock, {
        command: cliPath,
        coderProfile: "mottbot-coder",
        defaultTimeoutMs: 5_000,
        artifactRoot: path.join(root, "artifacts"),
      });
      const prepared = service.prepare({
        jobId: "job-1",
        cwd: root,
        prompt: "test prompt",
        artifactSegments: ["task-1", "subtask-1"],
      });
      const events: CodexCliEventRecord[] = [];
      const finished = new Promise<CodexCliFinishedPatch>((resolve) => {
        service.start(prepared, {
          onEvent: (record) => events.push(record),
          onFinished: resolve,
        });
      });

      const patch = await finished;

      expect(patch.status).toBe("exited");
      expect(events.map((event) => event.eventType)).toEqual(["thread.started", "turn.completed"]);
      expect(fs.readFileSync(prepared.stdoutLogPath, "utf8")).toContain("thread.started");
      expect(fs.readFileSync(prepared.stderrLogPath, "utf8")).toBe("warn");
      expect(fs.readFileSync(prepared.jsonlLogPath, "utf8")).toContain("turn.completed");
      expect(fs.readFileSync(prepared.finalMessagePath, "utf8")).toBe("final answer");
    } finally {
      removeTempDir(root);
    }
  });

  it("cancels running jobs", async () => {
    const root = createTempDir();
    try {
      const cliPath = path.join(root, "fake-codex.js");
      fs.writeFileSync(cliPath, "#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n", { mode: 0o755 });
      const clock: Clock = { now: () => Date.now() };
      const service = new CodexCliService(clock, {
        command: cliPath,
        coderProfile: "mottbot-coder",
        defaultTimeoutMs: 5_000,
        artifactRoot: path.join(root, "artifacts"),
      });
      const prepared = service.prepare({
        jobId: "job-1",
        cwd: root,
        prompt: "long prompt",
        artifactSegments: ["task-1", "subtask-1"],
      });
      const finished = new Promise<CodexCliFinishedPatch>((resolve) => {
        service.start(prepared, {
          onFinished: resolve,
        });
      });

      expect(service.cancel("job-1")).toBe(true);
      const patch = await finished;

      expect(patch.status).toBe("cancelled");
      expect(service.cancel("job-1")).toBe(false);
    } finally {
      removeTempDir(root);
    }
  });
});
