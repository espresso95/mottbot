import { describe, expect, it, vi } from "vitest";
import { createTelegramSendToolHandlers } from "../../src/tools/telegram-send-handlers.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { ToolHandler } from "../../src/tools/executor.js";

const definition: ToolDefinition = {
  name: "mottbot_telegram_send_message",
  description: "Send a Telegram message.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
  sideEffect: "telegram_send",
  enabled: true,
};

async function runTool(
  handler: ToolHandler,
  input: Record<string, unknown>,
  context: { chatId?: string; threadId?: number } = {},
): Promise<unknown> {
  return await handler({
    definition,
    arguments: input,
    ...context,
  });
}

describe("Telegram send tool handlers", () => {
  it("sends plain text to the current chat and current thread", async () => {
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 123 })),
    };
    const handlers = createTelegramSendToolHandlers(api as never, { allowedChatIds: [] });

    const result = await runTool(
      handlers.mottbot_telegram_send_message!,
      {
        text: "approved message",
        replyToMessageId: 42,
        disableNotification: true,
      },
      {
        chatId: "chat-1",
        threadId: 9,
      },
    );

    expect(result).toEqual({
      ok: true,
      action: "sent_message",
      chatId: "chat-1",
      messageId: 123,
      sizeChars: 16,
      disableNotification: true,
    });
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", "approved message", {
      message_thread_id: 9,
      reply_parameters: { message_id: 42 },
      disable_notification: true,
    });
  });

  it("allows only the current chat or configured approved targets", async () => {
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 456 })),
    };
    const handlers = createTelegramSendToolHandlers(api as never, { allowedChatIds: ["chat-2"] });

    await expect(
      runTool(
        handlers.mottbot_telegram_send_message!,
        {
          chatId: "chat-3",
          text: "blocked",
        },
        {
          chatId: "chat-1",
        },
      ),
    ).rejects.toThrow(/not approved/);

    const result = await runTool(
      handlers.mottbot_telegram_send_message!,
      {
        chatId: "chat-2",
        text: "allowed",
      },
      {
        chatId: "chat-1",
        threadId: 9,
      },
    );
    expect(result).toMatchObject({
      chatId: "chat-2",
      messageId: 456,
    });
    expect(api.sendMessage).toHaveBeenCalledWith("chat-2", "allowed", {});
  });

  it("requires a target chat and non-empty text", async () => {
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    };
    const handlers = createTelegramSendToolHandlers(api as never, { allowedChatIds: [] });

    await expect(
      runTool(handlers.mottbot_telegram_send_message!, {
        text: "missing chat",
      }),
    ).rejects.toThrow(/chatId is required/);
    await expect(
      runTool(
        handlers.mottbot_telegram_send_message!,
        {
          text: " ",
        },
        {
          chatId: "chat-1",
        },
      ),
    ).rejects.toThrow(/text is required/);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
