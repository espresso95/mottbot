import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { parseJsonlChunk } from "./codex-jsonl-parser.js";
import type { Clock } from "../shared/clock.js";
import type { ProjectTaskStore } from "../project-tasks/project-task-store.js";

type ActiveProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  cliRunId: string;
  subtaskId: string;
  timeout: NodeJS.Timeout;
};

export type CodexCliRunnerConfig = {
  command: string;
  coderProfile: string;
  defaultTimeoutMs: number;
  artifactRoot: string;
};

export class CodexCliRunner {
  private readonly active = new Map<string, ActiveProcess>();

  constructor(
    private readonly store: ProjectTaskStore,
    private readonly clock: Clock,
    private readonly config: CodexCliRunnerConfig,
  ) {}

  start(params: { taskId: string; subtaskId: string; cwd: string; prompt: string }): string {
    const runDir = path.join(this.config.artifactRoot, params.taskId, params.subtaskId);
    fs.mkdirSync(runDir, { recursive: true });
    const stdoutLogPath = path.join(runDir, "stdout.jsonl");
    const stderrLogPath = path.join(runDir, "stderr.log");
    const jsonlLogPath = path.join(runDir, "events.jsonl");
    const finalMessagePath = path.join(runDir, "final.md");
    const args = [
      "exec",
      "--cd",
      params.cwd,
      "--json",
      "--profile",
      this.config.coderProfile,
      "--output-last-message",
      finalMessagePath,
      params.prompt,
    ];
    const run = this.store.createCliRun({
      taskId: params.taskId,
      subtaskId: params.subtaskId,
      commandJson: JSON.stringify({ command: this.config.command, args }),
      cwd: params.cwd,
      stdoutLogPath,
      stderrLogPath,
      jsonlLogPath,
      finalMessagePath,
    });
    const child = spawn(this.config.command, args, {
      cwd: params.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutFd = fs.openSync(stdoutLogPath, "a");
    const stderrFd = fs.openSync(stderrLogPath, "a");
    const jsonlFd = fs.openSync(jsonlLogPath, "a");
    let eventIndex = 0;
    let parseBuffer = "";

    this.store.updateCliRun(run.cliRunId, {
      status: "streaming",
      pid: child.pid,
      startedAt: this.clock.now(),
    });

    child.stdout.on("data", (chunk: Buffer) => {
      fs.writeSync(stdoutFd, chunk);
      const raw = chunk.toString("utf8");
      const parsed = parseJsonlChunk(parseBuffer, raw);
      parseBuffer = parsed.nextBuffer;
      for (const event of parsed.events) {
        eventIndex += 1;
        const eventJson = JSON.stringify(event);
        fs.writeSync(jsonlFd, `${eventJson}\n`);
        this.store.addCliEvent({
          cliRunId: run.cliRunId,
          eventIndex,
          eventType: typeof event.type === "string" ? event.type : undefined,
          eventJson,
        });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      fs.writeSync(stderrFd, chunk);
    });

    const closeFiles = () => {
      fs.closeSync(stdoutFd);
      fs.closeSync(stderrFd);
      fs.closeSync(jsonlFd);
    };

    const timeout = setTimeout(() => {
      if (child.killed) {
        return;
      }
      child.kill("SIGTERM");
      this.store.updateCliRun(run.cliRunId, {
        status: "timed_out",
        finishedAt: this.clock.now(),
        lastError: `Timed out after ${this.config.defaultTimeoutMs}ms`,
      });
    }, this.config.defaultTimeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      closeFiles();
      this.active.delete(params.subtaskId);
      this.store.updateCliRun(run.cliRunId, {
        status: "failed",
        finishedAt: this.clock.now(),
        lastError: error.message,
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      closeFiles();
      this.active.delete(params.subtaskId);
      this.store.updateCliRun(run.cliRunId, {
        status: code === 0 ? "exited" : signal === "SIGTERM" ? "cancelled" : "failed",
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
        finishedAt: this.clock.now(),
        ...(code === 0
          ? {}
          : { lastError: `Codex exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}` }),
      });
    });

    this.active.set(params.subtaskId, { child, cliRunId: run.cliRunId, subtaskId: params.subtaskId, timeout });
    return run.cliRunId;
  }

  cancelSubtask(subtaskId: string): boolean {
    const current = this.active.get(subtaskId);
    if (!current) {
      return false;
    }
    clearTimeout(current.timeout);
    current.child.kill("SIGTERM");
    return true;
  }
}
