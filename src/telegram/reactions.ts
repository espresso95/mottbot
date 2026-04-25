import type { Api, Context } from "grammy";
import type { ReactionType } from "grammy/types";
import type { Clock } from "../shared/clock.js";

/** Normalized Telegram message-reaction delta used by notifications and tests. */
export type NormalizedReactionEvent = {
  updateId: number;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  messageId: number;
  fromUserId?: string;
  fromUsername?: string;
  addedEmojis: string[];
  removedEmojis: string[];
  arrivedAt: number;
};

/** Thin wrapper around Telegram reaction APIs used by run and tool status flows. */
export class TelegramReactionService {
  constructor(private readonly api: Api) {}

  async setEmojiReaction(params: { chatId: string; messageId: number; emoji: string; isBig?: boolean }): Promise<true> {
    const reaction: ReactionType[] = params.emoji ? [{ type: "emoji", emoji: params.emoji } as ReactionType] : [];
    return this.api.setMessageReaction(params.chatId, params.messageId, reaction, params.isBig ? { is_big: true } : {});
  }

  async clearReaction(params: { chatId: string; messageId: number }): Promise<true> {
    return this.setEmojiReaction({
      chatId: params.chatId,
      messageId: params.messageId,
      emoji: "",
    });
  }
}

function emojiFromReaction(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return record.type === "emoji" && typeof record.emoji === "string" ? record.emoji : undefined;
}

function collectReactionEmojis(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((reaction) => emojiFromReaction(reaction) ?? []) : [];
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function diffReactionEmojis(params: { oldEmojis: string[]; newEmojis: string[] }): {
  addedEmojis: string[];
  removedEmojis: string[];
} {
  const oldCounts = countValues(params.oldEmojis);
  const newCounts = countValues(params.newEmojis);
  const addedEmojis: string[] = [];
  const removedEmojis: string[] = [];
  for (const [emoji, count] of newCounts) {
    const delta = count - (oldCounts.get(emoji) ?? 0);
    for (let index = 0; index < delta; index += 1) {
      addedEmojis.push(emoji);
    }
  }
  for (const [emoji, count] of oldCounts) {
    const delta = count - (newCounts.get(emoji) ?? 0);
    for (let index = 0; index < delta; index += 1) {
      removedEmojis.push(emoji);
    }
  }
  return { addedEmojis, removedEmojis };
}

/** Converts a grammY message_reaction update into added and removed emoji deltas. */
export function normalizeReactionUpdate(params: { ctx: Context; clock: Clock }): NormalizedReactionEvent | undefined {
  const reaction = params.ctx.update.message_reaction;
  if (!reaction) {
    return undefined;
  }
  const rawReaction = reaction as unknown as Record<string, unknown>;
  const chat =
    rawReaction.chat && typeof rawReaction.chat === "object" ? (rawReaction.chat as Record<string, unknown>) : null;
  if (!chat || (typeof chat.id !== "number" && typeof chat.id !== "string")) {
    return undefined;
  }
  if (typeof rawReaction.message_id !== "number") {
    return undefined;
  }
  const user =
    rawReaction.user && typeof rawReaction.user === "object" ? (rawReaction.user as Record<string, unknown>) : null;
  const diff = diffReactionEmojis({
    oldEmojis: collectReactionEmojis(rawReaction.old_reaction),
    newEmojis: collectReactionEmojis(rawReaction.new_reaction),
  });
  return {
    updateId: params.ctx.update.update_id,
    chatId: String(chat.id),
    chatType:
      chat.type === "private" || chat.type === "group" || chat.type === "supergroup" || chat.type === "channel"
        ? chat.type
        : "private",
    messageId: rawReaction.message_id,
    ...(user && (typeof user.id === "number" || typeof user.id === "string") ? { fromUserId: String(user.id) } : {}),
    ...(user && typeof user.username === "string" ? { fromUsername: user.username } : {}),
    addedEmojis: diff.addedEmojis,
    removedEmojis: diff.removedEmojis,
    arrivedAt: params.clock.now(),
  };
}

function formatActor(event: NormalizedReactionEvent): string {
  if (event.fromUsername) {
    return `@${event.fromUsername}`;
  }
  if (event.fromUserId) {
    return `user ${event.fromUserId}`;
  }
  return "unknown user";
}

/** Formats a concise operator notification for a normalized reaction delta. */
export function formatReactionNotification(event: NormalizedReactionEvent): string {
  const parts = [
    event.addedEmojis.length > 0 ? `added ${event.addedEmojis.join(" ")}` : undefined,
    event.removedEmojis.length > 0 ? `removed ${event.removedEmojis.join(" ")}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `Telegram reaction ${parts.join("; ")} by ${formatActor(event)} on msg ${event.messageId}.`;
}
