import { describe, expect, it } from "vitest";
import { FakeClock } from "../helpers/fakes.js";
import { normalizeCallbackQuery, normalizeUpdate } from "../../src/telegram/update-normalizer.js";

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

  it("marks slash commands addressed to another bot as non-command events", () => {
    const event = normalizeUpdate({
      clock: new FakeClock(123),
      botUsername: "@mottbot",
      ctx: {
        update: { update_id: 12 },
        message: {
          message_id: 24,
          text: "/help@OtherBot",
          chat: { id: 42, type: "private" },
          from: { id: 77 },
        },
      } as any,
    });

    expect(event).toMatchObject({
      text: "/help@OtherBot",
      commandTargetUsername: "OtherBot",
      isCommand: false,
    });
  });

  it("accepts slash commands addressed to this bot", () => {
    const event = normalizeUpdate({
      clock: new FakeClock(123),
      botUsername: "MottBot",
      ctx: {
        update: { update_id: 13 },
        message: {
          message_id: 25,
          text: "/help@mottbot",
          chat: { id: 42, type: "private" },
          from: { id: 77 },
        },
      } as any,
    });

    expect(event).toMatchObject({
      commandTargetUsername: "mottbot",
      isCommand: true,
    });
  });

  it("returns null when no message is present", () => {
    expect(
      normalizeUpdate({
        clock: new FakeClock(),
        ctx: { update: { update_id: 1 } } as any,
      }),
    ).toBeNull();
  });

  it("normalizes callback query button data", () => {
    const event = normalizeCallbackQuery({
      clock: new FakeClock(456),
      ctx: {
        update: { update_id: 12 },
        callbackQuery: {
          id: "callback-12",
          data: "mb:ta:approval-1",
          message: {
            message_id: 24,
            message_thread_id: 8,
            text: "Approval required.",
            chat: { id: -1001, type: "supergroup" },
          },
          from: { id: 77, username: "nim" },
        },
      } as any,
    });

    expect(event).toEqual({
      updateId: 12,
      callbackQueryId: "callback-12",
      chatId: "-1001",
      chatType: "supergroup",
      messageId: 24,
      threadId: 8,
      fromUserId: "77",
      fromUsername: "nim",
      data: "mb:ta:approval-1",
      messageText: "Approval required.",
      arrivedAt: 456,
    });
  });

  it("returns null for callback queries without message-backed data", () => {
    const clock = new FakeClock();
    expect(normalizeCallbackQuery({ clock, ctx: { update: { update_id: 1 } } as any })).toBeNull();
    expect(
      normalizeCallbackQuery({
        clock,
        ctx: { update: { update_id: 1 }, callbackQuery: { id: "cb", message: { chat: { id: 1 } } } } as any,
      }),
    ).toBeNull();
    expect(
      normalizeCallbackQuery({
        clock,
        ctx: { update: { update_id: 1 }, callbackQuery: { data: "mb:ta:1", message: { chat: { id: 1 } } } } as any,
      }),
    ).toBeNull();
    expect(
      normalizeCallbackQuery({
        clock,
        ctx: { update: { update_id: 1 }, callbackQuery: { id: "cb", data: "mb:ta:1" } } as any,
      }),
    ).toBeNull();
  });
});
