import fs from "node:fs";
import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import type { AppConfig } from "./config.js";
import { launchAgentPaths, serviceStatus, type LaunchAgentPaths } from "./service.js";

export type RecentRunDiagnostic = {
  runId: string;
  sessionKey: string;
  status: string;
  modelRef: string;
  transport?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
};

type RecentRunRow = {
  run_id: string;
  session_key: string;
  status: string;
  model_ref: string;
  transport: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

export type RecentRunsParams = {
  limit?: number;
  sessionKey?: string;
  statuses?: string[];
};

export type RecentLogsParams = {
  stream?: "stdout" | "stderr" | "both";
  lines?: number;
};

const MAX_LOG_READ_BYTES = 128 * 1024;

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function tailFileLines(filePath: string, requestedLines: number): string[] {
  if (!fs.existsSync(filePath)) {
    return [`[missing] ${filePath}`];
  }
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, MAX_LOG_READ_BYTES);
  const buffer = Buffer.alloc(bytesToRead);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buffer
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return lines.slice(-requestedLines);
}

function mapRun(row: RecentRunRow): RecentRunDiagnostic {
  return {
    runId: row.run_id,
    sessionKey: row.session_key,
    status: row.status,
    modelRef: row.model_ref,
    ...(row.transport ? { transport: row.transport } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
  };
}

function formatRun(run: RecentRunDiagnostic): string {
  const details = [
    run.transport ? `transport=${run.transport}` : undefined,
    run.errorCode ? `error=${run.errorCode}` : undefined,
    run.errorMessage ? `message=${run.errorMessage}` : undefined,
  ].filter(Boolean);
  return [
    `- ${run.runId.slice(0, 8)} ${run.status} ${run.modelRef}`,
    `session=${run.sessionKey}`,
    `updated=${new Date(run.updatedAt).toISOString()}`,
    ...details,
  ].join(" | ");
}

export class OperatorDiagnostics {
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
    private readonly options: {
      serviceStatus?: () => string;
      launchAgentPaths?: Pick<LaunchAgentPaths, "stdoutPath" | "stderrPath">;
    } = {},
  ) {}

  serviceStatus(): string {
    try {
      return (this.options.serviceStatus ?? serviceStatus)();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Service status unavailable: ${message}`;
    }
  }

  recentRuns(params: RecentRunsParams = {}): RecentRunDiagnostic[] {
    const limit = clampInteger(params.limit, 10, 1, 25);
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (params.sessionKey) {
      clauses.push("session_key = ?");
      values.push(params.sessionKey);
    }
    if (params.statuses && params.statuses.length > 0) {
      clauses.push(`status in (${params.statuses.map(() => "?").join(", ")})`);
      values.push(...params.statuses);
    }
    const rows = this.database.db
      .prepare<unknown[], RecentRunRow>(
        `select run_id, session_key, status, model_ref, transport, error_code, error_message, created_at, updated_at, finished_at
         from runs
         ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
         order by created_at desc
         limit ?`,
      )
      .all(...values, limit);
    return rows.map(mapRun);
  }

  recentRunsText(params: RecentRunsParams = {}): string {
    const runs = this.recentRuns(params);
    return runs.length > 0 ? ["Recent runs:", ...runs.map(formatRun)].join("\n") : "No recent runs.";
  }

  recentErrorsText(limit = 10): string {
    const runs = this.recentRuns({
      limit,
      statuses: ["failed", "cancelled"],
    });
    const lines = tailFileLines(this.paths().stderrPath, clampInteger(limit, 10, 1, 50));
    return [
      runs.length > 0 ? ["Recent failed or cancelled runs:", ...runs.map(formatRun)].join("\n") : "No failed or cancelled runs.",
      lines.length > 0 ? ["Recent stderr log lines:", ...lines.map((line) => `- ${line}`)].join("\n") : "No stderr log lines.",
    ].join("\n\n");
  }

  recentLogsText(params: RecentLogsParams = {}): string {
    const stream = params.stream ?? "both";
    const lines = clampInteger(params.lines, 40, 1, 100);
    const paths = this.paths();
    const sections: string[] = [];
    if (stream === "stdout" || stream === "both") {
      sections.push(["stdout:", ...tailFileLines(paths.stdoutPath, lines).map((line) => `- ${line}`)].join("\n"));
    }
    if (stream === "stderr" || stream === "both") {
      sections.push(["stderr:", ...tailFileLines(paths.stderrPath, lines).map((line) => `- ${line}`)].join("\n"));
    }
    return sections.join("\n\n");
  }

  configText(): string {
    return [
      "Runtime config:",
      `- model: ${this.config.models.default}`,
      `- transport: ${this.config.models.transport}`,
      `- profile: ${this.config.auth.defaultProfile}`,
      `- mode: ${this.config.telegram.polling ? "polling" : "webhook"}`,
      `- dashboard: ${this.config.dashboard.enabled ? "enabled" : "disabled"}`,
      `- side-effect tools: ${this.config.tools.enableSideEffectTools ? "enabled" : "disabled"}`,
      `- auto memory summaries: ${this.config.memory.autoSummariesEnabled ? "enabled" : "disabled"}`,
      `- sqlite: ${this.config.storage.sqlitePath}`,
      `- generated: ${new Date(this.clock.now()).toISOString()}`,
    ].join("\n");
  }

  private paths(): Pick<LaunchAgentPaths, "stdoutPath" | "stderrPath"> {
    return this.options.launchAgentPaths ?? launchAgentPaths();
  }
}
