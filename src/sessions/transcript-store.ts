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
      ...(typeof params.telegramMessageId === "number"
        ? { telegramMessageId: params.telegramMessageId }
        : {}),
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
      .prepare<unknown[], MessageRow>(
        "select * from messages where session_key = ? order by created_at desc limit ?",
      )
      .all(sessionKey, limit);
    return rows.reverse().map(mapMessageRow);
  }

  clearSession(sessionKey: string): void {
    this.database.db.prepare("delete from messages where session_key = ?").run(sessionKey);
  }

  hasRunMessage(runId: string, role?: TranscriptMessageRole): boolean {
    const row = this.database.db
      .prepare<unknown[], { id: string }>(
        role
          ? "select id from messages where run_id = ? and role = ? limit 1"
          : "select id from messages where run_id = ? limit 1",
      )
      .get(...(role ? [runId, role] : [runId]));
    return Boolean(row);
  }
}
