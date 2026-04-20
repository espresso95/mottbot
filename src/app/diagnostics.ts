import fs from "node:fs";
import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import type { AppConfig } from "./config.js";
import { launchAgentPaths, serviceStatus, type LaunchAgentPaths } from "./service.js";

export type RecentRunDiagnostic = {
  runId: string;
  sessionKey: string;
  agentId: string;
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
  agent_id: string;
  status: string;
  model_ref: string;
  transport: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
};

export type AgentDiagnostic = {
  agentId: string;
  configured: boolean;
  displayName?: string;
  profileId?: string;
  modelRef?: string;
  fastMode?: boolean;
  maxConcurrentRuns?: number;
  maxQueuedRuns?: number;
  routeCount: number;
  queuedRuns: number;
  activeRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
};

type CountByAgentRow = {
  agent_id: string;
  count: number;
};

type RunCountsByAgentRow = {
  agent_id: string;
  queued_runs: number;
  active_runs: number;
  completed_runs: number;
  failed_runs: number;
  cancelled_runs: number;
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

function logHeading(label: string, filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return `${label} (missing):`;
  }
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink()) {
    return `${label} (symlink):`;
  }
  return `${label} (${stats.size} bytes):`;
}

function mapRun(row: RecentRunRow): RecentRunDiagnostic {
  return {
    runId: row.run_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
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
    `agent=${run.agentId}`,
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

function formatAgent(agent: AgentDiagnostic): string {
  const limits = [
    agent.maxConcurrentRuns !== undefined ? `maxConcurrent=${agent.maxConcurrentRuns}` : "maxConcurrent=unlimited",
    agent.maxQueuedRuns !== undefined ? `maxQueued=${agent.maxQueuedRuns}` : "maxQueued=unlimited",
  ].join(", ");
  const labels = [
    agent.configured ? "configured" : "stale",
    agent.displayName ? `name=${agent.displayName}` : undefined,
    agent.modelRef ? `model=${agent.modelRef}` : undefined,
    agent.profileId ? `profile=${agent.profileId}` : undefined,
    agent.fastMode ? "fast" : undefined,
  ].filter(Boolean);
  return [
    `- ${agent.agentId} [${labels.join(", ")}]`,
    limits,
    `routes=${agent.routeCount}`,
    `queued=${agent.queuedRuns}`,
    `active=${agent.activeRuns}`,
    `completed=${agent.completedRuns}`,
    `failed=${agent.failedRuns}`,
    `cancelled=${agent.cancelledRuns}`,
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
        `select run_id, session_key, agent_id, status, model_ref, transport, error_code, error_message, created_at, updated_at, finished_at
         from runs
         ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
         order by created_at desc
         limit ?`,
      )
      .all(...values, limit);
    return rows.map(mapRun);
  }

  agentDiagnostics(): AgentDiagnostic[] {
    const diagnostics = new Map<string, AgentDiagnostic>();
    for (const agent of this.config.agents.list) {
      diagnostics.set(agent.id, {
        agentId: agent.id,
        configured: true,
        ...(agent.displayName ? { displayName: agent.displayName } : {}),
        profileId: agent.profileId,
        modelRef: agent.modelRef,
        fastMode: agent.fastMode,
        ...(agent.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: agent.maxConcurrentRuns } : {}),
        ...(agent.maxQueuedRuns !== undefined ? { maxQueuedRuns: agent.maxQueuedRuns } : {}),
        routeCount: 0,
        queuedRuns: 0,
        activeRuns: 0,
        completedRuns: 0,
        failedRuns: 0,
        cancelledRuns: 0,
      });
    }

    const ensureDiagnostic = (agentId: string): AgentDiagnostic => {
      const existing = diagnostics.get(agentId);
      if (existing) {
        return existing;
      }
      const created: AgentDiagnostic = {
        agentId,
        configured: false,
        routeCount: 0,
        queuedRuns: 0,
        activeRuns: 0,
        completedRuns: 0,
        failedRuns: 0,
        cancelledRuns: 0,
      };
      diagnostics.set(agentId, created);
      return created;
    };

    const routeRows = this.database.db
      .prepare<unknown[], CountByAgentRow>(
        `select agent_id, count(*) as count
         from session_routes
         group by agent_id`,
      )
      .all();
    for (const row of routeRows) {
      ensureDiagnostic(row.agent_id).routeCount = row.count;
    }

    const runRows = this.database.db
      .prepare<unknown[], RunCountsByAgentRow>(
        `select agent_id,
                sum(case when status = 'queued' then 1 else 0 end) as queued_runs,
                sum(case when status in ('starting', 'streaming') then 1 else 0 end) as active_runs,
                sum(case when status = 'completed' then 1 else 0 end) as completed_runs,
                sum(case when status = 'failed' then 1 else 0 end) as failed_runs,
                sum(case when status = 'cancelled' then 1 else 0 end) as cancelled_runs
         from runs
         group by agent_id`,
      )
      .all();
    for (const row of runRows) {
      const diagnostic = ensureDiagnostic(row.agent_id);
      diagnostic.queuedRuns = row.queued_runs;
      diagnostic.activeRuns = row.active_runs;
      diagnostic.completedRuns = row.completed_runs;
      diagnostic.failedRuns = row.failed_runs;
      diagnostic.cancelledRuns = row.cancelled_runs;
    }

    return [...diagnostics.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  agentDiagnosticsText(): string {
    const agents = this.agentDiagnostics();
    return agents.length > 0 ? ["Agent diagnostics:", ...agents.map(formatAgent)].join("\n") : "No agents configured.";
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
      sections.push([logHeading("stdout", paths.stdoutPath), ...tailFileLines(paths.stdoutPath, lines).map((line) => `- ${line}`)].join("\n"));
    }
    if (stream === "stderr" || stream === "both") {
      sections.push([logHeading("stderr", paths.stderrPath), ...tailFileLines(paths.stderrPath, lines).map((line) => `- ${line}`)].join("\n"));
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
