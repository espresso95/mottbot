import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";

/** Role of an outbound bot message persisted for reply routing and outbox recovery. */
export type TelegramBotMessageKind = "placeholder" | "primary" | "continuation" | "failure";

/** Tracks outbound Telegram message ids so replies can be routed back to sessions. */
export class TelegramMessageStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  record(params: {
    runId?: string;
    sessionKey?: string;
    chatId: string;
    threadId?: number;
    telegramMessageId: number;
    kind: TelegramBotMessageKind;
  }): void {
    this.database.db
      .prepare(
        `insert or ignore into telegram_bot_messages (
          id, run_id, session_key, chat_id, thread_id, telegram_message_id, message_kind, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createId(),
        params.runId ?? null,
        params.sessionKey ?? null,
        params.chatId,
        params.threadId ?? null,
        params.telegramMessageId,
        params.kind,
        this.clock.now(),
      );
  }

  hasMessage(params: { chatId: string; threadId?: number; telegramMessageId: number }): boolean {
    const row = this.database.db
      .prepare<unknown[], { telegram_message_id: number }>(
        `select telegram_message_id
         from telegram_bot_messages
         where chat_id = ? and thread_id is ? and telegram_message_id = ?
         limit 1`,
      )
      .get(params.chatId, params.threadId ?? null, params.telegramMessageId);
    return Boolean(row);
  }

  hasMessageInChat(params: { chatId: string; telegramMessageId: number }): boolean {
    const row = this.database.db
      .prepare<unknown[], { telegram_message_id: number }>(
        `select telegram_message_id
         from telegram_bot_messages
         where chat_id = ? and telegram_message_id = ?
         limit 1`,
      )
      .get(params.chatId, params.telegramMessageId);
    return Boolean(row);
  }
}
