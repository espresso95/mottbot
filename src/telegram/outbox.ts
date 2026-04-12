import type { Api } from "grammy";
import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { Logger } from "../shared/logger.js";
import { splitTelegramText } from "./formatting.js";

type OutboxHandle = {
  outboxId: string;
  runId: string;
  chatId: string;
  threadId?: number;
  messageId: number;
  lastText: string;
  lastEditAt: number;
};

export class TelegramOutbox {
  constructor(
    private readonly api: Api,
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly editThrottleMs: number,
  ) {}

  async start(params: {
    runId: string;
    chatId: string;
    threadId?: number;
    replyToMessageId?: number;
    placeholderText: string;
  }): Promise<OutboxHandle> {
    const sent = await this.api.sendMessage(params.chatId, params.placeholderText, {
      ...(typeof params.threadId === "number" ? { message_thread_id: params.threadId } : {}),
      ...(typeof params.replyToMessageId === "number" ? { reply_parameters: { message_id: params.replyToMessageId } } : {}),
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
    return handle;
  }

  async update(handle: OutboxHandle, text: string): Promise<OutboxHandle> {
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
      await this.api.editMessageText(handle.chatId, handle.messageId, nextText);
      const next = {
        ...handle,
        lastText: nextText,
        lastEditAt: now,
      };
      this.touch(next, "active");
      return next;
    } catch (error) {
      this.logger.warn({ error }, "Failed to edit Telegram message.");
      return handle;
    }
  }

  async finish(handle: OutboxHandle, text: string): Promise<void> {
    const chunks = splitTelegramText(text);
    const [first, ...rest] = chunks;
    if (first) {
      try {
        await this.api.editMessageText(handle.chatId, handle.messageId, first);
      } catch (error) {
        this.logger.warn({ error }, "Failed to finalize Telegram message by editing.");
        await this.api.sendMessage(handle.chatId, first, {
          ...(typeof handle.threadId === "number" ? { message_thread_id: handle.threadId } : {}),
        });
      }
    }
    for (const chunk of rest) {
      await this.api.sendMessage(handle.chatId, chunk, {
        ...(typeof handle.threadId === "number" ? { message_thread_id: handle.threadId } : {}),
      });
    }
    this.touch(
      {
        ...handle,
        lastText: text,
        lastEditAt: this.clock.now(),
      },
      "final",
    );
  }

  async fail(handle: OutboxHandle, text: string): Promise<void> {
    try {
      await this.api.editMessageText(handle.chatId, handle.messageId, text);
    } catch {
      await this.api.sendMessage(handle.chatId, text, {
        ...(typeof handle.threadId === "number" ? { message_thread_id: handle.threadId } : {}),
      });
    }
    this.touch(
      {
        ...handle,
        lastText: text,
        lastEditAt: this.clock.now(),
      },
      "failed",
    );
  }

  private touch(handle: OutboxHandle, state: "active" | "final" | "failed"): void {
    this.database.db
      .prepare(
        `update outbox_messages
         set state = ?, last_rendered_text = ?, last_edit_at = ?, updated_at = ?
         where id = ?`,
      )
      .run(state, handle.lastText, handle.lastEditAt, this.clock.now(), handle.outboxId);
  }
}
