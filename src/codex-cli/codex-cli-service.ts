import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { parseJsonlChunk, type CodexJsonlEvent } from "./codex-jsonl-parser.js";
import type { Clock } from "../shared/clock.js";

/** Lifecycle state for a reusable Codex CLI job. */
export type CodexCliJobStatus = "starting" | "streaming" | "exited" | "failed" | "cancelled" | "timed_out";

/** Runtime settings for Codex CLI job services. */
type CodexCliServiceConfig = {
  command: string;
  coderProfile: string;
  defaultTimeoutMs: number;
  artifactRoot: string;
};

/** Input required to prepare a Codex CLI job before spawning it. */
type CodexCliJobPrepareParams = {
  jobId: string;
  cwd: string;
  prompt: string;
  artifactSegments: readonly string[];
  profile?: string;
  timeoutMs?: number;
};

/** Artifact paths allocated for one Codex CLI job. */
type CodexCliJobPaths = {
  runDir: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  jsonlLogPath: string;
  finalMessagePath: string;
};

/** Prepared Codex CLI job including command args and artifact paths. */
type CodexCliPreparedJob = CodexCliJobPaths & {
  jobId: string;
  cwd: string;
  prompt: string;
  command: string;
  args: string[];
  commandJson: string;
  profile: string;
  timeoutMs: number;
};

/** Parsed JSONL event record emitted by a running Codex CLI job. */
export type CodexCliEventRecord = {
  eventIndex: number;
  eventType?: string;
  event: CodexJsonlEvent;
  eventJson: string;
};

/** Store patch emitted when a Codex CLI job reaches a terminal state. */
export type CodexCliFinishedPatch = {
  status: CodexCliJobStatus;
  exitCode?: number;
  signal?: string;
  finishedAt: number;
  lastError?: string;
};

/** Callbacks invoked as a Codex CLI job starts streaming, emits events, and finishes. */
type CodexCliServiceCallbacks = {
  onStreaming?: (params: { pid?: number; startedAt: number }) => void;
  onEvent?: (record: CodexCliEventRecord) => void;
  onFinished?: (patch: CodexCliFinishedPatch) => void;
};

type ActiveProcess = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  timeout: NodeJS.Timeout;
  cancelled: boolean;
  timedOut: boolean;
  closedFiles: boolean;
  stdoutFd: number;
  stderrFd: number;
  jsonlFd: number;
};

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateArtifactSegment(segment: string): void {
  if (!segment.trim()) {
    throw new Error("Codex CLI artifact path segment cannot be empty.");
  }
  if (
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new Error(`Invalid Codex CLI artifact path segment ${segment}.`);
  }
}

/** Builds artifact paths for a job while preventing path traversal outside the artifact root. */
export function buildCodexCliJobPaths(artifactRoot: string, artifactSegments: readonly string[]): CodexCliJobPaths {
  if (artifactSegments.length === 0) {
    throw new Error("Codex CLI artifact path requires at least one segment.");
  }
  for (const segment of artifactSegments) {
    validateArtifactSegment(segment);
  }
  const root = path.resolve(artifactRoot);
  const runDir = path.resolve(root, ...artifactSegments);
  if (!isInside(root, runDir)) {
    throw new Error("Codex CLI artifact path resolves outside the artifact root.");
  }
  return {
    runDir,
    stdoutLogPath: path.join(runDir, "stdout.jsonl"),
    stderrLogPath: path.join(runDir, "stderr.log"),
    jsonlLogPath: path.join(runDir, "events.jsonl"),
    finalMessagePath: path.join(runDir, "final.md"),
  };
}

/** Builds the Codex CLI exec arguments for a prepared job. */
function buildCodexCliArgs(params: {
  cwd: string;
  profile: string;
  finalMessagePath: string;
  prompt: string;
}): string[] {
  return [
    "exec",
    "--cd",
    params.cwd,
    "--json",
    "--profile",
    params.profile,
    "--output-last-message",
    params.finalMessagePath,
    params.prompt,
  ];
}

function childProcessEnv(): NodeJS.ProcessEnv {
  const nodeBinDir = path.dirname(process.execPath);
  const currentPath = process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const nextPath = pathEntries.includes(nodeBinDir) ? currentPath : [nodeBinDir, currentPath].join(path.delimiter);
  return {
    ...process.env,
    PATH: nextPath,
  };
}

/** Reusable service for preparing, spawning, tracking, and cancelling Codex CLI jobs. */
export class CodexCliService {
  private readonly active = new Map<string, ActiveProcess>();

  constructor(
    private readonly clock: Clock,
    private readonly config: CodexCliServiceConfig,
  ) {}

  prepare(params: CodexCliJobPrepareParams): CodexCliPreparedJob {
    const command = this.config.command.trim();
    if (!command) {
      throw new Error("Codex CLI command cannot be empty.");
    }
    const profile = params.profile?.trim() || this.config.coderProfile;
    const timeoutMs = params.timeoutMs ?? this.config.defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Codex CLI timeout must be a positive integer.");
    }
    const paths = buildCodexCliJobPaths(this.config.artifactRoot, params.artifactSegments);
    const args = buildCodexCliArgs({
      cwd: params.cwd,
      profile,
      finalMessagePath: paths.finalMessagePath,
      prompt: params.prompt,
    });
    return {
      jobId: params.jobId,
      cwd: params.cwd,
      prompt: params.prompt,
      command,
      args,
      commandJson: JSON.stringify({ command, args }),
      profile,
      timeoutMs,
      ...paths,
    };
  }

  start(job: CodexCliPreparedJob, callbacks: CodexCliServiceCallbacks = {}): void {
    if (this.active.has(job.jobId)) {
      throw new Error(`Codex CLI job ${job.jobId} is already running.`);
    }
    fs.mkdirSync(job.runDir, { recursive: true });
    const stdoutFd = fs.openSync(job.stdoutLogPath, "a");
    const stderrFd = fs.openSync(job.stderrLogPath, "a");
    const jsonlFd = fs.openSync(job.jsonlLogPath, "a");
    const child = spawn(job.command, job.args, {
      cwd: job.cwd,
      env: childProcessEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const active: ActiveProcess = {
      child,
      timeout: setTimeout(() => {
        active.timedOut = true;
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }, job.timeoutMs),
      cancelled: false,
      timedOut: false,
      closedFiles: false,
      stdoutFd,
      stderrFd,
      jsonlFd,
    };
    this.active.set(job.jobId, active);

    let eventIndex = 0;
    let parseBuffer = "";
    callbacks.onStreaming?.({ pid: child.pid, startedAt: this.clock.now() });

    child.stdout.on("data", (chunk: Buffer) => {
      fs.writeSync(stdoutFd, chunk);
      const parsed = parseJsonlChunk(parseBuffer, chunk.toString("utf8"));
      parseBuffer = parsed.nextBuffer;
      for (const event of parsed.events) {
        eventIndex += 1;
        const eventJson = JSON.stringify(event);
        fs.writeSync(jsonlFd, `${eventJson}\n`);
        callbacks.onEvent?.({
          eventIndex,
          eventType: typeof event.type === "string" ? event.type : undefined,
          event,
          eventJson,
        });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      fs.writeSync(stderrFd, chunk);
    });

    child.on("error", (error) => {
      this.finish(
        job.jobId,
        {
          status: "failed",
          finishedAt: this.clock.now(),
          lastError: error.message,
        },
        callbacks,
      );
    });

    child.on("close", (code, signal) => {
      const current = this.active.get(job.jobId);
      const timedOut = current?.timedOut ?? false;
      const cancelled = current?.cancelled ?? false;
      const status = this.closeStatus({ code, signal, timedOut, cancelled });
      this.finish(
        job.jobId,
        {
          status,
          exitCode: code ?? undefined,
          signal: signal ?? undefined,
          finishedAt: this.clock.now(),
          ...(status === "failed" || status === "timed_out"
            ? { lastError: this.closeError({ code, signal, timedOut, timeoutMs: job.timeoutMs }) }
            : {}),
        },
        callbacks,
      );
    });
  }

  cancel(jobId: string): boolean {
    const current = this.active.get(jobId);
    if (!current) {
      return false;
    }
    current.cancelled = true;
    clearTimeout(current.timeout);
    current.child.kill("SIGTERM");
    return true;
  }

  private closeStatus(params: {
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    cancelled: boolean;
  }): CodexCliJobStatus {
    if (params.timedOut) {
      return "timed_out";
    }
    if (params.cancelled || params.signal === "SIGTERM") {
      return "cancelled";
    }
    return params.code === 0 ? "exited" : "failed";
  }

  private closeError(params: {
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    timeoutMs: number;
  }): string {
    if (params.timedOut) {
      return `Timed out after ${params.timeoutMs}ms`;
    }
    return `Codex exited with code ${params.code ?? "null"}${params.signal ? ` signal ${params.signal}` : ""}`;
  }

  private finish(jobId: string, patch: CodexCliFinishedPatch, callbacks: CodexCliServiceCallbacks): void {
    const current = this.active.get(jobId);
    if (!current) {
      return;
    }
    clearTimeout(current.timeout);
    this.closeFiles(current);
    this.active.delete(jobId);
    callbacks.onFinished?.(patch);
  }

  private closeFiles(current: ActiveProcess): void {
    if (current.closedFiles) {
      return;
    }
    current.closedFiles = true;
    fs.closeSync(current.stdoutFd);
    fs.closeSync(current.stderrFd);
    fs.closeSync(current.jsonlFd);
  }
}
