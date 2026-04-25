import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import type { InboundEvent } from "../telegram/types.js";
import type { CodexToolCall } from "../codex/tool-calls.js";
import type { ToolApprovalAuditRecord } from "../tools/approval.js";

/** Durable queue state for inbound Telegram events waiting on run processing. */
export type RunQueueState = "queued" | "claimed" | "completed" | "failed";

/** Persisted queue entry containing the inbound event and lease metadata. */
export type RunQueueRecord = {
  runId: string;
  sessionKey: string;
  chatId: string;
  threadId?: number;
  messageId: number;
  replyToMessageId?: number;
  eventJson?: string;
  state: RunQueueState;
  attempts: number;
  claimedAt?: number;
  leaseExpiresAt?: number;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
};

/** Durable continuation payload for an approved tool callback waiting in the run queue. */
export type RunQueueApprovedToolContinuation = {
  type: "approved_tool";
  pending: ToolApprovalAuditRecord;
  toolCall: CodexToolCall;
};

type RunQueueRow = {
  run_id: string;
  session_key: string;
  chat_id: string;
  thread_id: number | null;
  message_id: number;
  reply_to_message_id: number | null;
  event_json: string | null;
  state: RunQueueState;
  attempts: number;
  claimed_at: number | null;
  lease_expires_at: number | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

function mapRunQueueRow(row: RunQueueRow | undefined): RunQueueRecord | undefined {
  if (!row) {
    return undefined;
  }
  return {
    runId: row.run_id,
    sessionKey: row.session_key,
    chatId: row.chat_id,
    ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
    messageId: row.message_id,
    ...(row.reply_to_message_id !== null ? { replyToMessageId: row.reply_to_message_id } : {}),
    ...(row.event_json ? { eventJson: row.event_json } : {}),
    state: row.state,
    attempts: row.attempts,
    ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** SQLite-backed queue for recovering and leasing inbound run work across restarts. */
export class RunQueueStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  create(params: {
    runId: string;
    sessionKey: string;
    event: InboundEvent;
    approvedToolContinuation?: RunQueueApprovedToolContinuation;
  }): RunQueueRecord {
    const now = this.clock.now();
    const eventJson = JSON.stringify({
      chatType: params.event.chatType,
      fromUserId: params.event.fromUserId,
      fromUsername: params.event.fromUsername,
      text: params.event.text,
      caption: params.event.caption,
      attachments: params.event.attachments,
      mentionsBot: params.event.mentionsBot,
      isCommand: params.event.isCommand,
      arrivedAt: params.event.arrivedAt,
      ...(params.approvedToolContinuation ? { approvedToolContinuation: params.approvedToolContinuation } : {}),
    });
    this.database.db
      .prepare(
        `insert into run_queue (
          run_id, session_key, chat_id, thread_id, message_id, reply_to_message_id, event_json, state, attempts, claimed_at, lease_expires_at, error_message, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, 'queued', 0, null, null, null, ?, ?)`,
      )
      .run(
        params.runId,
        params.sessionKey,
        params.event.chatId,
        params.event.threadId ?? null,
        params.event.messageId,
        params.event.replyToMessageId ?? null,
        eventJson,
        now,
        now,
      );
    return this.get(params.runId)!;
  }

  get(runId: string): RunQueueRecord | undefined {
    const row = this.database.db.prepare<unknown[], RunQueueRow>("select * from run_queue where run_id = ?").get(runId);
    return mapRunQueueRow(row);
  }

  claim(runId: string, leaseMs: number, options: { recoverClaimed?: boolean } = {}): RunQueueRecord | undefined {
    const now = this.clock.now();
    const recoverClaimed = options.recoverClaimed ? 1 : 0;
    const result = this.database.db
      .prepare(
        `update run_queue
         set state = 'claimed',
             attempts = attempts + 1,
             claimed_at = ?,
             lease_expires_at = ?,
             error_message = null,
             updated_at = ?
         where run_id = ?
           and (
             state = 'queued'
             or (state = 'claimed' and (lease_expires_at <= ? or ? = 1))
           )`,
      )
      .run(now, now + leaseMs, now, runId, now, recoverClaimed);
    if (result.changes === 0) {
      return undefined;
    }
    const claimed = this.get(runId);
    return claimed?.state === "claimed" ? claimed : undefined;
  }

  complete(runId: string): void {
    this.finish(runId, "completed");
  }

  fail(runId: string, errorMessage: string): void {
    this.finish(runId, "failed", errorMessage);
  }

  listRecoverableQueued(): RunQueueRecord[] {
    const rows = this.database.db
      .prepare<unknown[], RunQueueRow>(
        `select q.*
         from run_queue q
         join runs r on r.run_id = q.run_id
         where q.state in ('queued', 'claimed')
           and r.status = 'queued'
         order by q.created_at asc`,
      )
      .all();
    return rows.flatMap((row) => {
      const mapped = mapRunQueueRow(row);
      return mapped ? [mapped] : [];
    });
  }

  failRuns(runIds: string[], errorMessage: string): void {
    if (runIds.length === 0) {
      return;
    }
    const now = this.clock.now();
    const placeholders = runIds.map(() => "?").join(", ");
    this.database.db
      .prepare(
        `update run_queue
         set state = 'failed',
             error_message = ?,
             lease_expires_at = null,
             updated_at = ?
         where run_id in (${placeholders})`,
      )
      .run(errorMessage, now, ...runIds);
  }

  private finish(runId: string, state: "completed" | "failed", errorMessage?: string): void {
    const now = this.clock.now();
    this.database.db
      .prepare(
        `update run_queue
         set state = ?,
             error_message = ?,
             lease_expires_at = null,
             updated_at = ?
         where run_id = ?`,
      )
      .run(state, errorMessage ?? null, now, runId);
  }
}
