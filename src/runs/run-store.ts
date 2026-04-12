import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { RunRecord, RunStatus } from "../sessions/types.js";

type RunRow = {
  run_id: string;
  session_key: string;
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

function mapRunRow(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    sessionKey: row.session_key,
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

  create(params: { sessionKey: string; modelRef: string; profileId: string }): RunRecord {
    const now = this.clock.now();
    const run: RunRecord = {
      runId: createId(),
      sessionKey: params.sessionKey,
      status: "queued",
      modelRef: params.modelRef,
      profileId: params.profileId,
      createdAt: now,
      updatedAt: now,
    };
    this.database.db
      .prepare(
        `insert into runs (
          run_id, session_key, status, model_ref, profile_id, transport, request_identity, started_at, finished_at, error_code, error_message, usage_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, null, null, null, null, null, null, null, ?, ?)`,
      )
      .run(run.runId, run.sessionKey, run.status, run.modelRef, run.profileId, run.createdAt, run.updatedAt);
    return run;
  }

  get(runId: string): RunRecord | undefined {
    const row = this.database.db
      .prepare<unknown[], RunRow>("select * from runs where run_id = ?")
      .get(runId);
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
         set status = ?, model_ref = ?, profile_id = ?, transport = ?, request_identity = ?, started_at = ?, finished_at = ?, error_code = ?, error_message = ?, usage_json = ?, updated_at = ?
         where run_id = ?`,
      )
      .run(
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
}
