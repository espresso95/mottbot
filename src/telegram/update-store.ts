import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";

export type BeginUpdateResult =
  | { accepted: true; reason: "new" }
  | { accepted: false; reason: "processed" | "inflight" };

export class TelegramUpdateStore {
  private readonly inflight = new Set<number>();

  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  begin(updateId: number): BeginUpdateResult {
    if (this.inflight.has(updateId)) {
      return { accepted: false, reason: "inflight" };
    }
    const existing = this.database.db
      .prepare<unknown[], { update_id: number }>("select update_id from telegram_updates where update_id = ?")
      .get(updateId);
    if (existing) {
      return { accepted: false, reason: "processed" };
    }
    this.inflight.add(updateId);
    return { accepted: true, reason: "new" };
  }

  markProcessed(params: {
    updateId: number;
    chatId?: string;
    messageId?: number;
  }): void {
    this.database.db
      .prepare(
        `insert or ignore into telegram_updates (
          update_id, chat_id, message_id, processed_at
        ) values (?, ?, ?, ?)`,
      )
      .run(params.updateId, params.chatId ?? null, params.messageId ?? null, this.clock.now());
    this.inflight.delete(params.updateId);
  }

  release(updateId: number): void {
    this.inflight.delete(updateId);
  }

  countProcessed(): number {
    const row = this.database.db
      .prepare<unknown[], { count: number }>("select count(*) as count from telegram_updates")
      .get();
    return row?.count ?? 0;
  }
}
