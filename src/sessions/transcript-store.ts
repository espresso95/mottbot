import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { TranscriptMessage, TranscriptMessageRole } from "./types.js";

type MessageRow = {
  id: string;
  session_key: string;
  run_id: string | null;
  role: TranscriptMessageRole;
  telegram_message_id: number | null;
  reply_to_telegram_message_id: number | null;
  content_text: string | null;
  content_json: string | null;
  created_at: number;
};

type MessageJsonRow = {
  id: string;
  content_json: string | null;
};

function mapMessageRow(row: MessageRow): TranscriptMessage {
  return {
    id: row.id,
    sessionKey: row.session_key,
    ...(row.run_id ? { runId: row.run_id } : {}),
    role: row.role,
    ...(row.telegram_message_id !== null ? { telegramMessageId: row.telegram_message_id } : {}),
    ...(row.reply_to_telegram_message_id !== null
      ? { replyToTelegramMessageId: row.reply_to_telegram_message_id }
      : {}),
    ...(row.content_text !== null ? { contentText: row.content_text } : {}),
    ...(row.content_json !== null ? { contentJson: row.content_json } : {}),
    createdAt: row.created_at,
  };
}

/** Persists transcript messages and retrieves bounded history for prompt construction. */
export class TranscriptStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  add(params: {
    sessionKey: string;
    role: TranscriptMessageRole;
    contentText?: string;
    contentJson?: string;
    runId?: string;
    telegramMessageId?: number;
    replyToTelegramMessageId?: number;
  }): TranscriptMessage {
    const message: TranscriptMessage = {
      id: createId(),
      sessionKey: params.sessionKey,
      ...(params.runId ? { runId: params.runId } : {}),
      role: params.role,
      ...(params.contentText ? { contentText: params.contentText } : {}),
      ...(params.contentJson ? { contentJson: params.contentJson } : {}),
      ...(typeof params.telegramMessageId === "number" ? { telegramMessageId: params.telegramMessageId } : {}),
      ...(typeof params.replyToTelegramMessageId === "number"
        ? { replyToTelegramMessageId: params.replyToTelegramMessageId }
        : {}),
      createdAt: this.clock.now(),
    };
    this.database.db
      .prepare(
        `insert into messages (
          id, session_key, run_id, role, telegram_message_id, reply_to_telegram_message_id, content_text, content_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionKey,
        message.runId ?? null,
        message.role,
        message.telegramMessageId ?? null,
        message.replyToTelegramMessageId ?? null,
        message.contentText ?? null,
        message.contentJson ?? null,
        message.createdAt,
      );
    return message;
  }

  listRecent(sessionKey: string, limit = 30): TranscriptMessage[] {
    const rows = this.database.db
      .prepare<unknown[], MessageRow>("select * from messages where session_key = ? order by created_at desc limit ?")
      .all(sessionKey, limit);
    return rows.reverse().map(mapMessageRow);
  }

  getRunMessage(runId: string, role: TranscriptMessageRole): TranscriptMessage | undefined {
    const row = this.database.db
      .prepare<
        unknown[],
        MessageRow
      >("select * from messages where run_id = ? and role = ? order by created_at asc limit 1")
      .get(runId, role);
    return row ? mapMessageRow(row) : undefined;
  }

  clearSession(sessionKey: string): void {
    this.database.db.prepare("delete from messages where session_key = ?").run(sessionKey);
  }

  updateRunMessageContentJson(runId: string, role: TranscriptMessageRole, contentJson?: string): void {
    this.database.db
      .prepare("update messages set content_json = ? where run_id = ? and role = ?")
      .run(contentJson ?? null, runId, role);
  }

  removeAttachmentMetadata(params: { sessionKey: string; runId?: string; recordId?: string }): number {
    const rows = this.database.db
      .prepare<unknown[], MessageJsonRow>(
        `select id, content_json
         from messages
         where session_key = ?
           and content_json is not null
           ${params.runId ? "and run_id = ?" : ""}`,
      )
      .all(...(params.runId ? [params.sessionKey, params.runId] : [params.sessionKey]));
    let changed = 0;
    const update = this.database.db.prepare("update messages set content_json = ? where id = ?");
    const save = this.database.db.transaction(() => {
      for (const row of rows) {
        if (!row.content_json) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.content_json);
        } catch {
          continue;
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !Array.isArray((parsed as { attachments?: unknown }).attachments)
        ) {
          continue;
        }
        const recordId = params.recordId;
        const nextAttachments = recordId
          ? (parsed as { attachments: Array<Record<string, unknown>> }).attachments.filter(
              (attachment) => attachment.recordId !== recordId,
            )
          : [];
        if (nextAttachments.length === (parsed as { attachments: unknown[] }).attachments.length) {
          continue;
        }
        const nextEnvelope = {
          ...(parsed as Record<string, unknown>),
          ...(nextAttachments.length > 0 ? { attachments: nextAttachments } : {}),
        };
        if (nextAttachments.length === 0) {
          delete nextEnvelope.attachments;
        }
        const nextJson = Object.keys(nextEnvelope).length > 0 ? JSON.stringify(nextEnvelope) : null;
        update.run(nextJson, row.id);
        changed += 1;
      }
    });
    save();
    return changed;
  }

  hasRunMessage(runId: string, role?: TranscriptMessageRole): boolean {
    const row = this.database.db
      .prepare<
        unknown[],
        { id: string }
      >(role ? "select id from messages where run_id = ? and role = ? limit 1" : "select id from messages where run_id = ? limit 1")
      .get(...(role ? [runId, role] : [runId]));
    return Boolean(row);
  }
}
