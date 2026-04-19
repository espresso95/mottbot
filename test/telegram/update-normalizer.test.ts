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

  it("normalizes Telegram attachment metadata without file bytes", () => {
    const event = normalizeUpdate({
      clock: new FakeClock(123),
      botUsername: "mottbot",
      ctx: {
        update: { update_id: 11 },
        message: {
          message_id: 23,
          caption: "inspect this",
          chat: { id: 42, type: "private" },
          from: { id: 77 },
          photo: [
            { file_id: "small-photo", file_unique_id: "small", width: 90, height: 90, file_size: 1000 },
            { file_id: "large-photo", file_unique_id: "large", width: 1280, height: 720, file_size: 250000 },
          ],
          document: {
            file_id: "doc-1",
            file_unique_id: "doc-unique",
            file_name: "report.pdf",
            mime_type: "application/pdf",
            file_size: 4096,
          },
        },
      } as any,
    });

    expect(event?.attachments).toEqual([
      {
        kind: "photo",
        fileId: "large-photo",
        fileUniqueId: "large",
        width: 1280,
        height: 720,
        fileSize: 250000,
      },
      {
        kind: "document",
        fileId: "doc-1",
        fileUniqueId: "doc-unique",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        fileSize: 4096,
      },
    ]);
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
