import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { RunRecord, RunStatus } from "../sessions/types.js";

type RunRow = {
  run_id: string;
  session_key: string;
  agent_id: string;
  status: RunStatus;
  model_ref: string;
  profile_id: string;
  transport: string | null;
  request_identity: string | null;
  started_at: number | null;
  finished_at: number | null;
  error_code: string | null;
  error_message: string | null;
  usage_json: string | null;
  created_at: number;
  updated_at: number;
};

export type UsageBudgetRunCountScope = {
  since: number;
  sessionKey?: string;
  chatId?: string;
  userId?: string;
  modelRef?: string;
  excludeRunId?: string;
};

export type UsageBudgetModelCount = {
  modelRef: string;
  runs: number;
};

function mapRunRow(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    sessionKey: row.session_key,
    agentId: row.agent_id,
    status: row.status,
    modelRef: row.model_ref,
    profileId: row.profile_id,
    ...(row.transport ? { transport: row.transport } : {}),
    ...(row.request_identity ? { requestIdentity: row.request_identity } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.usage_json ? { usageJson: row.usage_json } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RunStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  create(params: { sessionKey: string; modelRef: string; profileId: string; agentId?: string }): RunRecord {
    const now = this.clock.now();
    const run: RunRecord = {
      runId: createId(),
      sessionKey: params.sessionKey,
      agentId: params.agentId ?? "main",
      status: "queued",
      modelRef: params.modelRef,
      profileId: params.profileId,
      createdAt: now,
      updatedAt: now,
    };
    this.database.db
      .prepare(
        `insert into runs (
          run_id, session_key, agent_id, status, model_ref, profile_id, transport, request_identity, started_at, finished_at, error_code, error_message, usage_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, null, null, null, null, null, null, null, ?, ?)`,
      )
      .run(
        run.runId,
        run.sessionKey,
        run.agentId,
        run.status,
        run.modelRef,
        run.profileId,
        run.createdAt,
        run.updatedAt,
      );
    return run;
  }

  get(runId: string): RunRecord | undefined {
    const row = this.database.db.prepare<unknown[], RunRow>("select * from runs where run_id = ?").get(runId);
    return row ? mapRunRow(row) : undefined;
  }

  update(runId: string, patch: Partial<Omit<RunRecord, "runId" | "sessionKey" | "createdAt">>): RunRecord {
    const current = this.get(runId);
    if (!current) {
      throw new Error(`Unknown run ${runId}.`);
    }
    const next: RunRecord = {
      ...current,
      ...patch,
      updatedAt: this.clock.now(),
    };
    this.database.db
      .prepare(
        `update runs
         set agent_id = ?, status = ?, model_ref = ?, profile_id = ?, transport = ?, request_identity = ?, started_at = ?, finished_at = ?, error_code = ?, error_message = ?, usage_json = ?, updated_at = ?
         where run_id = ?`,
      )
      .run(
        next.agentId,
        next.status,
        next.modelRef,
        next.profileId,
        next.transport ?? null,
        next.requestIdentity ?? null,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.errorCode ?? null,
        next.errorMessage ?? null,
        next.usageJson ?? null,
        next.updatedAt,
        runId,
      );
    return next;
  }

  countByStatuses(statuses: RunStatus[]): number {
    if (statuses.length === 0) {
      return 0;
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.database.db
      .prepare<unknown[], { count: number }>(`select count(*) as count from runs where status in (${placeholders})`)
      .get(...statuses);
    return row?.count ?? 0;
  }

  countByAgentStatuses(agentId: string, statuses: RunStatus[]): number {
    if (statuses.length === 0) {
      return 0;
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.database.db
      .prepare<unknown[], { count: number }>(
        `select count(*) as count
         from runs
         where agent_id = ?
           and status in (${placeholders})`,
      )
      .get(agentId, ...statuses);
    return row?.count ?? 0;
  }

  countUsageBudgetRuns(params: UsageBudgetRunCountScope): number {
    const conditions = [
      "runs.created_at >= ?",
      "not (runs.status = 'failed' and runs.error_code = 'usage_budget_denied')",
    ];
    const values: unknown[] = [params.since];
    if (params.sessionKey) {
      conditions.push("runs.session_key = ?");
      values.push(params.sessionKey);
    }
    if (params.chatId) {
      conditions.push("session_routes.chat_id = ?");
      values.push(params.chatId);
    }
    if (params.userId) {
      conditions.push("session_routes.user_id = ?");
      values.push(params.userId);
    }
    if (params.modelRef) {
      conditions.push("runs.model_ref = ?");
      values.push(params.modelRef);
    }
    if (params.excludeRunId) {
      conditions.push("runs.run_id <> ?");
      values.push(params.excludeRunId);
    }
    const row = this.database.db
      .prepare<unknown[], { count: number }>(
        `select count(*) as count
         from runs
         left join session_routes on session_routes.session_key = runs.session_key
         where ${conditions.join(" and ")}`,
      )
      .get(...values);
    return row?.count ?? 0;
  }

  countUsageBudgetRunsByModel(params: { since: number; limit?: number }): UsageBudgetModelCount[] {
    return this.database.db
      .prepare<unknown[], UsageBudgetModelCount>(
        `select runs.model_ref as modelRef, count(*) as runs
         from runs
         where runs.created_at >= ?
           and not (runs.status = 'failed' and runs.error_code = 'usage_budget_denied')
         group by runs.model_ref
         order by runs desc, runs.model_ref asc
         limit ?`,
      )
      .all(params.since, Math.min(Math.max(params.limit ?? 10, 1), 50));
  }

  recoverInterruptedRuns(): RunRecord[] {
    const rows = this.database.db
      .prepare<
        unknown[],
        RunRow
      >("select * from runs where status in ('starting', 'streaming') order by created_at asc")
      .all();
    if (rows.length === 0) {
      return [];
    }
    const now = this.clock.now();
    const recovered = rows.map(mapRunRow);
    const update = this.database.db.prepare(
      `update runs
       set status = ?, error_code = ?, error_message = ?, finished_at = ?, updated_at = ?
       where run_id = ?`,
    );
    const transaction = this.database.db.transaction((items: RunRecord[]) => {
      for (const item of items) {
        update.run("failed", "restart_recovery", "Recovered as failed after process restart.", now, now, item.runId);
      }
    });
    transaction(recovered);
    return recovered.map((item) => ({
      ...item,
      status: "failed",
      errorCode: "restart_recovery",
      errorMessage: "Recovered as failed after process restart.",
      finishedAt: now,
      updatedAt: now,
    }));
  }
}
