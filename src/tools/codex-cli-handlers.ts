import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../app/config.js";
import { CodexCliService, type CodexCliEventRecord, type CodexCliJobStatus } from "../codex-cli/codex-cli-service.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { ToolHandler } from "./executor.js";
import { createRepositoryScope } from "./repository-scope.js";

const MAX_RETAINED_EVENTS = 500;
const FINAL_MESSAGE_MAX_BYTES = 4_000;

type CodexToolJob = {
  jobId: string;
  status: CodexCliJobStatus;
  root: string;
  cwd: string;
  displayCwd: string;
  promptPreview: string;
  profile: string;
  timeoutMs: number;
  commandJson: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  jsonlLogPath: string;
  finalMessagePath: string;
  events: CodexCliEventRecord[];
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  pid?: number;
  exitCode?: number;
  signal?: string;
  lastError?: string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireString(value: unknown, name: string): string {
  const trimmed = optionalString(value);
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function promptPreview(prompt: string): string {
  return prompt.length > 240 ? `${prompt.slice(0, 237)}...` : prompt;
}

function readFinalMessage(path: string): string | undefined {
  if (!fs.existsSync(path)) {
    return undefined;
  }
  const fd = fs.openSync(path, "r");
  try {
    const buffer = Buffer.alloc(FINAL_MESSAGE_MAX_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, FINAL_MESSAGE_MAX_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function limit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number") {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(value), max));
}

function publicJob(job: CodexToolJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    status: job.status,
    root: job.root,
    cwd: job.cwd,
    displayCwd: job.displayCwd,
    promptPreview: job.promptPreview,
    profile: job.profile,
    timeoutMs: job.timeoutMs,
    pid: job.pid,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    lastError: job.lastError,
    eventCount: job.events.length,
    stdoutLogPath: job.stdoutLogPath,
    stderrLogPath: job.stderrLogPath,
    jsonlLogPath: job.jsonlLogPath,
    finalMessagePath: job.finalMessagePath,
    finalMessage: readFinalMessage(job.finalMessagePath),
  };
}

function eventSummary(record: CodexCliEventRecord): Record<string, unknown> {
  const text = typeof record.event.text === "string" ? record.event.text : undefined;
  const message = typeof record.event.message === "string" ? record.event.message : undefined;
  return {
    eventIndex: record.eventIndex,
    eventType: record.eventType,
    ...(text ? { text } : {}),
    ...(message ? { message } : {}),
    event: record.event,
  };
}

/** Creates tool handlers for starting, inspecting, and cancelling reusable Codex CLI jobs. */
export function createCodexCliToolHandlers(config: AppConfig, clock: Clock): Partial<Record<string, ToolHandler>> {
  const scope = createRepositoryScope({
    roots: config.codexJobs.repoRoots,
    deniedPaths: [],
    maxReadBytes: 1,
    maxSearchMatches: 1,
    maxSearchBytes: 1,
    commandTimeoutMs: 1,
  });
  const service = new CodexCliService(clock, {
    command: config.codexJobs.codex.command,
    coderProfile: config.codexJobs.codex.coderProfile,
    defaultTimeoutMs: config.codexJobs.codex.defaultTimeoutMs,
    artifactRoot: config.codexJobs.artifactRoot,
  });
  const jobs = new Map<string, CodexToolJob>();

  function getJob(jobId: unknown): CodexToolJob {
    const id = requireString(jobId, "jobId");
    const job = jobs.get(id);
    if (!job) {
      throw new Error(`Unknown Codex CLI job ${id}.`);
    }
    return job;
  }

  const startJob: ToolHandler = ({ arguments: input }) => {
    const prompt = requireString(input.prompt, "prompt");
    const root = scope.resolveRoot(optionalString(input.root));
    if (!fs.existsSync(path.join(root.realPath, ".git"))) {
      throw new Error("Codex CLI jobs must start from a configured git checkout root.");
    }
    const cwd = scope.resolvePath({
      root: root.realPath,
      targetPath: optionalString(input.cwd),
    });
    const requestedTimeout =
      typeof input.timeoutMs === "number" ? input.timeoutMs : config.codexJobs.codex.defaultTimeoutMs;
    const timeoutMs = Math.min(requestedTimeout, config.codexJobs.codex.defaultTimeoutMs);
    const jobId = createId();
    const prepared = service.prepare({
      jobId,
      cwd: cwd.realPath,
      prompt,
      artifactSegments: ["tool-jobs", jobId],
      profile: optionalString(input.profile),
      timeoutMs,
    });
    const job: CodexToolJob = {
      jobId,
      status: "starting",
      root: root.realPath,
      cwd: cwd.realPath,
      displayCwd: `${root.label}:${cwd.displayPath}`,
      promptPreview: promptPreview(prompt),
      profile: prepared.profile,
      timeoutMs: prepared.timeoutMs,
      commandJson: prepared.commandJson,
      stdoutLogPath: prepared.stdoutLogPath,
      stderrLogPath: prepared.stderrLogPath,
      jsonlLogPath: prepared.jsonlLogPath,
      finalMessagePath: prepared.finalMessagePath,
      events: [],
      updatedAt: clock.now(),
    };
    jobs.set(jobId, job);
    service.start(prepared, {
      onStreaming: ({ pid, startedAt }) => {
        job.status = "streaming";
        job.pid = pid;
        job.startedAt = startedAt;
        job.updatedAt = clock.now();
      },
      onEvent: (record) => {
        job.events.push(record);
        if (job.events.length > MAX_RETAINED_EVENTS) {
          job.events.splice(0, job.events.length - MAX_RETAINED_EVENTS);
        }
        job.updatedAt = clock.now();
      },
      onFinished: (patch) => {
        job.status = patch.status;
        job.exitCode = patch.exitCode;
        job.signal = patch.signal;
        job.finishedAt = patch.finishedAt;
        job.lastError = patch.lastError;
        job.updatedAt = clock.now();
      },
    });
    return publicJob(job);
  };

  return {
    mottbot_codex_job_start: startJob,
    mottbot_subagent_codex_start: startJob,
    mottbot_codex_job_status: ({ arguments: input }) => publicJob(getJob(input.jobId)),
    mottbot_codex_job_tail: ({ arguments: input }) => {
      const job = getJob(input.jobId);
      const count = limit(input.limit, 20, 50);
      return {
        ...publicJob(job),
        events: job.events.slice(-count).map(eventSummary),
      };
    },
    mottbot_codex_job_cancel: ({ arguments: input }) => {
      const job = getJob(input.jobId);
      const cancelled = service.cancel(job.jobId);
      if (cancelled) {
        job.status = "cancelled";
        job.updatedAt = clock.now();
      }
      return {
        cancelled,
        ...publicJob(job),
      };
    },
  };
}
