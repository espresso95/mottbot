import { describe, expect, it, vi } from "vitest";
import {
  TelegramReactionService,
  formatReactionNotification,
  normalizeReactionUpdate,
} from "../../src/telegram/reactions.js";
import { FakeClock } from "../helpers/fakes.js";

describe("Telegram reactions", () => {
  it("sets and clears emoji reactions through the Bot API", async () => {
    const api = {
      setMessageReaction: vi.fn(async () => true),
    };
    const service = new TelegramReactionService(api as any);

    await service.setEmojiReaction({
      chatId: "chat-1",
      messageId: 42,
      emoji: "\u{1F44D}",
      isBig: true,
    });
    await service.clearReaction({
      chatId: "chat-1",
      messageId: 42,
    });

    expect(api.setMessageReaction).toHaveBeenNthCalledWith(1, "chat-1", 42, [{ type: "emoji", emoji: "\u{1F44D}" }], {
      is_big: true,
    });
    expect(api.setMessageReaction).toHaveBeenNthCalledWith(2, "chat-1", 42, [], {});
  });

  it("normalizes added and removed emoji reaction updates", () => {
    const event = normalizeReactionUpdate({
      clock: new FakeClock(123),
      ctx: {
        update: {
          update_id: 7,
          message_reaction: {
            chat: { id: -100, type: "supergroup" },
            message_id: 42,
            user: { id: 5, username: "alice" },
            old_reaction: [
              { type: "emoji", emoji: "\u{1F44D}" },
              { type: "emoji", emoji: "\u{1F525}" },
            ],
            new_reaction: [
              { type: "emoji", emoji: "\u{1F525}" },
              { type: "emoji", emoji: "\u{2705}" },
            ],
          },
        },
      } as any,
    });

    expect(event).toEqual({
      updateId: 7,
      chatId: "-100",
      chatType: "supergroup",
      messageId: 42,
      fromUserId: "5",
      fromUsername: "alice",
      addedEmojis: ["\u{2705}"],
      removedEmojis: ["\u{1F44D}"],
      arrivedAt: 123,
    });
    expect(formatReactionNotification(event!)).toBe(
      "Telegram reaction added \u{2705}; removed \u{1F44D} by @alice on msg 42.",
    );
  });
});
