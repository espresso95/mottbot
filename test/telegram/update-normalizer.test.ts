import { describe, expect, it } from "vitest";
import { FakeClock } from "../helpers/fakes.js";
import { normalizeUpdate } from "../../src/telegram/update-normalizer.js";

describe("normalizeUpdate", () => {
  it("normalizes a text message with mentions and reply", () => {
    const clock = new FakeClock(123);
    const event = normalizeUpdate({
      clock,
      botUsername: "mottbot",
      ctx: {
        update: { update_id: 10 },
        message: {
          message_id: 22,
          message_thread_id: 7,
          text: "hello @mottbot",
          entities: [{ type: "mention", offset: 6, length: 8 }],
          chat: { id: -1001, type: "supergroup" },
          from: { id: 77, username: "nim" },
          reply_to_message: { message_id: 21 },
        },
      } as any,
    });

    expect(event).toMatchObject({
      updateId: 10,
      chatId: "-1001",
      chatType: "supergroup",
      messageId: 22,
      threadId: 7,
      fromUserId: "77",
      fromUsername: "nim",
      text: "hello @mottbot",
      mentionsBot: true,
      replyToMessageId: 21,
      arrivedAt: 123,
    });
    expect(event?.entities).toEqual([{ type: "mention", offset: 6, length: 8 }]);
  });

  it("returns null when no message is present", () => {
    expect(
      normalizeUpdate({
        clock: new FakeClock(),
        ctx: { update: { update_id: 1 } } as any,
      }),
    ).toBeNull();
  });
});
