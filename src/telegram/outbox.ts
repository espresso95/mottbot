import type { Api } from "grammy";
import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { Logger } from "../shared/logger.js";
import { isTransientRunStatus } from "../shared/run-status.js";
import { splitTelegramText } from "./formatting.js";
import type { TelegramMessageStore } from "./message-store.js";
import type { TelegramInlineKeyboard } from "./command-replies.js";

type TelegramOutboxApi = Pick<Api, "editMessageText" | "sendMessage">;

type OutboxHandle = {
  outboxId: string;
  runId: string;
  chatId: string;
  threadId?: number;
  messageId: number;
  lastText: string;
  lastEditAt: number;
};

type FinalizedOutbox = {
  primaryMessageId: number;
  continuationMessageIds: number[];
};

/** Sends, edits, finalizes, and recovers Telegram messages for streaming run output. */
export class TelegramOutbox {
  constructor(
    private readonly api: TelegramOutboxApi,
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly editThrottleMs: number,
    private readonly messages: TelegramMessageStore,
  ) {}

  async start(params: {
    runId: string;
    chatId: string;
    threadId?: number;
    replyToMessageId?: number;
    placeholderText: string;
    replyMarkup?: TelegramInlineKeyboard;
  }): Promise<OutboxHandle> {
    const sent = await this.api.sendMessage(params.chatId, params.placeholderText, {
      ...(typeof params.threadId === "number" ? { message_thread_id: params.threadId } : {}),
      ...(typeof params.replyToMessageId === "number"
        ? { reply_parameters: { message_id: params.replyToMessageId } }
        : {}),
      ...(params.replyMarkup ? { reply_markup: params.replyMarkup } : {}),
    });
    const now = this.clock.now();
    const handle: OutboxHandle = {
      outboxId: createId(),
      runId: params.runId,
      chatId: params.chatId,
      ...(typeof params.threadId === "number" ? { threadId: params.threadId } : {}),
      messageId: sent.message_id,
      lastText: params.placeholderText,
      lastEditAt: now,
    };
    this.database.db
      .prepare(
        `insert into outbox_messages (
          id, run_id, chat_id, thread_id, telegram_message_id, state, last_rendered_text, last_edit_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handle.outboxId,
        handle.runId,
        handle.chatId,
        handle.threadId ?? null,
        handle.messageId,
        "active",
        handle.lastText,
        handle.lastEditAt,
        now,
        now,
      );
    this.messages.record({
      runId: handle.runId,
      chatId: handle.chatId,
      threadId: handle.threadId,
      telegramMessageId: handle.messageId,
      kind: "placeholder",
    });
    return handle;
  }

  async update(
    handle: OutboxHandle,
    text: string,
    options: { replyMarkup?: TelegramInlineKeyboard } = {},
  ): Promise<OutboxHandle> {
    const chunks = splitTelegramText(text);
    const nextText = chunks[0] ?? "";
    if (!nextText || nextText === handle.lastText) {
      return handle;
    }
    const now = this.clock.now();
    if (now - handle.lastEditAt < this.editThrottleMs) {
      return handle;
    }
    try {
      await this.api.editMessageText(handle.chatId, handle.messageId, nextText, {
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      });
      const next = {
        ...handle,
        lastText: nextText,
        lastEditAt: now,
      };
      this.touch(next, "active");
      return next;
    } catch (error) {
      this.logger.warn({ error }, "Failed to edit Telegram message, sending continuation message.");
      try {
        const sent = await this.api.sendMessage(handle.chatId, nextText, {
          ...(typeof handle.threadId === "number" ? { message_thread_id: handle.threadId } : {}),
          ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        });
        const next = {
          ...handle,
          messageId: sent.message_id,
          lastText: nextText,
          lastEditAt: now,
        };
        this.messages.record({
          runId: handle.runId,
          chatId: handle.chatId,
          threadId: handle.threadId,
          telegramMessageId: sent.message_id,
          kind: "continuation",
        });
        this.touch(next, "active");
        return next;
      } catch (sendError) {
        this.logger.warn({ error: sendError }, "Failed to send continuation Telegram message.");
        return handle;
      }
    }
  }

  async finish(
    handle: OutboxHandle,
    text: string,
    options: { replyMarkup?: TelegramInlineKeyboard } = {},
  ): Promise<FinalizedOutbox> {
    const chunks = splitTelegramText(text);
    const [first, ...rest] = chunks;
    let primaryMessageId = handle.messageId;
    const continuationMessageIds: number[] = [];
    if (first) {
      try {
        await this.api.editMessageText(handle.chatId, primaryMessageId, first, {
          ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        });
      } catch (error) {
        this.logger.warn({ error }, "Failed to finalize Telegram message by editing.");
        const sent = await this.api.sendMessage(handle.chatId, first, {
          ...(typeof handle.threadId === "number" ? { message_thread_id: handle.threadId } : {}),
          ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        });
        primaryMessageId = sent.message_id;
        this.messages.record({
          runId: handle.runId,
          chatId: handle.chatId,
          threadId: handle.threadId,
          telegramMessageId: primaryMessageId,
          kind: "primary",
        });
      }
    }
    for (const chunk of rest) {
      const sent = await this.api.sendMessage(handle.chatId, chunk, {
        ...(typeof handle.threadId === "number" ? { message_thread_id: handle.threadId } : {}),
      });
      continuationMessageIds.push(sent.message_id);
      this.messages.record({
        runId: handle.runId,
        chatId: handle.chatId,
        threadId: handle.threadId,
        telegramMessageId: sent.message_id,
        kind: "continuation",
      });
    }
    this.touch(
      {
        ...handle,
        messageId: primaryMessageId,
        lastText: text,
        lastEditAt: this.clock.now(),
      },
      "final",
    );
    return {
      primaryMessageId,
      continuationMessageIds,
    };
  }

  async fail(
    handle: OutboxHandle,
    text: string,
    options: { replyMarkup?: TelegramInlineKeyboard } = {},
  ): Promise<{ primaryMessageId: number }> {
    let primaryMessageId = handle.messageId;
    try {
      await this.api.editMessageText(handle.chatId, primaryMessageId, text, {
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      });
    } catch {
      const sent = await this.api.sendMessage(handle.chatId, text, {
        ...(typeof handle.threadId === "number" ? { message_thread_id: handle.threadId } : {}),
        ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
      });
      primaryMessageId = sent.message_id;
      this.messages.record({
        runId: handle.runId,
        chatId: handle.chatId,
        threadId: handle.threadId,
        telegramMessageId: primaryMessageId,
        kind: "failure",
      });
    }
    this.touch(
      {
        ...handle,
        messageId: primaryMessageId,
        lastText: text,
        lastEditAt: this.clock.now(),
      },
      "failed",
    );
    return { primaryMessageId };
  }

  recoverInterruptedRuns(params: {
    runs: Array<{ runId: string; sessionKey: string }>;
  }): Array<{ runId: string; sessionKey: string; partialText?: string }> {
    if (params.runs.length === 0) {
      return [];
    }
    const runById = new Map(params.runs.map((run) => [run.runId, run]));
    const placeholders = params.runs.map(() => "?").join(", ");
    const rows = this.database.db
      .prepare<unknown[], { run_id: string; last_rendered_text: string | null }>(
        `select run_id, last_rendered_text
         from outbox_messages
         where run_id in (${placeholders})`,
      )
      .all(...params.runs.map((run) => run.runId));
    this.database.db
      .prepare(
        `update outbox_messages
         set state = 'failed', updated_at = ?
         where state = 'active' and run_id in (${placeholders})`,
      )
      .run(this.clock.now(), ...params.runs.map((run) => run.runId));
    return rows.flatMap((row) => {
      const run = runById.get(row.run_id);
      if (!run) {
        return [];
      }
      const partialText =
        row.last_rendered_text && !isTransientRunStatus(row.last_rendered_text) ? row.last_rendered_text : undefined;
      return [
        {
          runId: run.runId,
          sessionKey: run.sessionKey,
          ...(partialText ? { partialText } : {}),
        },
      ];
    });
  }

  private touch(handle: OutboxHandle, state: "active" | "final" | "failed"): void {
    this.database.db
      .prepare(
        `update outbox_messages
         set telegram_message_id = ?, state = ?, last_rendered_text = ?, last_edit_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(handle.messageId, state, handle.lastText, handle.lastEditAt, this.clock.now(), handle.outboxId);
  }
}
