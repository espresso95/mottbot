import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexCliJobPaths,
  CodexCliService,
  type CodexCliEventRecord,
  type CodexCliFinishedPatch,
} from "../../src/codex-cli/codex-cli-service.js";
import type { Clock } from "../../src/shared/clock.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

function createService(root: string, options: { command?: string; timeoutMs?: number } = {}): CodexCliService {
  const clock: Clock = { now: () => Date.now() };
  return new CodexCliService(clock, {
    command: options.command ?? path.join(root, "fake-codex.js"),
    coderProfile: "mottbot-coder",
    defaultTimeoutMs: options.timeoutMs ?? 5_000,
    artifactRoot: path.join(root, "artifacts"),
  });
}

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

  it("adds the current Node binary directory to child PATH", async () => {
    const root = createTempDir();
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = "/usr/bin:/bin";
      const cliPath = path.join(root, "fake-codex.js");
      fs.writeFileSync(
        cliPath,
        ["#!/usr/bin/env node", "console.log(JSON.stringify({ type: 'env.path', path: process.env.PATH }));"].join(
          "\n",
        ),
        { mode: 0o755 },
      );
      const service = createService(root, { command: cliPath });
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
      const event = events[0]?.event as { path?: string } | undefined;

      expect(patch.status).toBe("exited");
      expect(event?.path?.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    } finally {
      process.env.PATH = previousPath;
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

  it("rejects invalid job configuration before spawning", () => {
    const root = createTempDir();
    try {
      expect(() => buildCodexCliJobPaths(path.join(root, "artifacts"), [])).toThrow("requires at least one segment");
      expect(() => buildCodexCliJobPaths(path.join(root, "artifacts"), ["task", ".."])).toThrow(
        "Invalid Codex CLI artifact path segment",
      );

      const service = createService(root, { command: "   " });

      expect(() =>
        service.prepare({
          jobId: "job-1",
          cwd: root,
          prompt: "test",
          artifactSegments: ["task-1"],
        }),
      ).toThrow("Codex CLI command cannot be empty.");

      const validService = createService(root);
      expect(() =>
        validService.prepare({
          jobId: "job-2",
          cwd: root,
          prompt: "test",
          artifactSegments: ["task-1"],
          timeoutMs: 0,
        }),
      ).toThrow("timeout must be a positive integer");
    } finally {
      removeTempDir(root);
    }
  });

  it("reports spawn errors for missing commands", async () => {
    const root = createTempDir();
    try {
      const service = createService(root, { command: path.join(root, "missing-codex") });
      const prepared = service.prepare({
        jobId: "job-1",
        cwd: root,
        prompt: "test",
        artifactSegments: ["task-1", "subtask-1"],
      });
      const finished = new Promise<CodexCliFinishedPatch>((resolve) => {
        service.start(prepared, { onFinished: resolve });
      });

      const patch = await finished;

      expect(patch.status).toBe("failed");
      expect(patch.lastError).toContain("ENOENT");
      expect(fs.existsSync(prepared.stdoutLogPath)).toBe(true);
      expect(fs.existsSync(prepared.stderrLogPath)).toBe(true);
      expect(fs.existsSync(prepared.jsonlLogPath)).toBe(true);
    } finally {
      removeTempDir(root);
    }
  });

  it("reports failed exits and parse-error events", async () => {
    const root = createTempDir();
    try {
      const cliPath = path.join(root, "fake-codex.js");
      fs.writeFileSync(
        cliPath,
        [
          "#!/usr/bin/env node",
          'process.stdout.write(\'{"type":"split\');',
          "process.stdout.write('.event\"}\\n');",
          "process.stdout.write('not json\\n');",
          "process.stderr.write('fatal');",
          "process.exit(7);",
        ].join("\n"),
        { mode: 0o755 },
      );
      const service = createService(root, { command: cliPath });
      const prepared = service.prepare({
        jobId: "job-1",
        cwd: root,
        prompt: "test",
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

      expect(patch).toMatchObject({
        status: "failed",
        exitCode: 7,
        lastError: "Codex exited with code 7",
      });
      expect(events.map((event) => event.eventType)).toEqual(["split.event", "mottbot.parse_error"]);
      expect(fs.readFileSync(prepared.stderrLogPath, "utf8")).toBe("fatal");
    } finally {
      removeTempDir(root);
    }
  });

  it("times out long-running jobs and rejects duplicate starts", async () => {
    const root = createTempDir();
    try {
      const cliPath = path.join(root, "fake-codex.js");
      fs.writeFileSync(cliPath, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
      const service = createService(root, { command: cliPath, timeoutMs: 25 });
      const prepared = service.prepare({
        jobId: "job-1",
        cwd: root,
        prompt: "long prompt",
        artifactSegments: ["task-1", "subtask-1"],
      });
      const finished = new Promise<CodexCliFinishedPatch>((resolve) => {
        service.start(prepared, { onFinished: resolve });
      });

      expect(() => service.start(prepared)).toThrow("already running");

      const patch = await finished;

      expect(patch.status).toBe("timed_out");
      expect(patch.lastError).toBe("Timed out after 25ms");
    } finally {
      removeTempDir(root);
    }
  });

  it("allows successful jobs without a final message file", async () => {
    const root = createTempDir();
    try {
      const cliPath = path.join(root, "fake-codex.js");
      fs.writeFileSync(cliPath, "#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'done' }));\n", {
        mode: 0o755,
      });
      const service = createService(root, { command: cliPath });
      const prepared = service.prepare({
        jobId: "job-1",
        cwd: root,
        prompt: "test",
        artifactSegments: ["task-1", "subtask-1"],
      });
      const finished = new Promise<CodexCliFinishedPatch>((resolve) => {
        service.start(prepared, { onFinished: resolve });
      });

      const patch = await finished;

      expect(patch.status).toBe("exited");
      expect(fs.existsSync(prepared.finalMessagePath)).toBe(false);
    } finally {
      removeTempDir(root);
    }
  });
});
