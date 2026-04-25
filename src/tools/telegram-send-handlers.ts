import type { Api } from "grammy";
import type { ToolHandler } from "./executor.js";

/** Runtime allow-list for Telegram send-message tools. */
type TelegramSendToolConfig = {
  allowedChatIds: string[];
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Creates Telegram send-message tool handlers with target allow-list enforcement. */
export function createTelegramSendToolHandlers(
  api: Api,
  config: TelegramSendToolConfig,
): Partial<Record<string, ToolHandler>> {
  const allowedTargets = new Set(config.allowedChatIds.map((chatId) => chatId.trim()).filter(Boolean));
  return {
    mottbot_telegram_send_message: async ({ arguments: input, chatId: currentChatId, threadId }) => {
      const text = optionalString(input.text);
      if (!text) {
        throw new Error("text is required.");
      }
      const requestedChatId = optionalString(input.chatId);
      const targetChatId = requestedChatId ?? currentChatId;
      if (!targetChatId) {
        throw new Error("chatId is required when the current chat is unavailable.");
      }
      if (targetChatId !== currentChatId && !allowedTargets.has(targetChatId)) {
        throw new Error(`Telegram target ${targetChatId} is not approved for send-message tools.`);
      }
      const replyToMessageId = optionalInteger(input.replyToMessageId);
      const sent = await api.sendMessage(targetChatId, text, {
        ...(threadId !== undefined && targetChatId === currentChatId ? { message_thread_id: threadId } : {}),
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
        ...(optionalBoolean(input.disableNotification) !== undefined
          ? { disable_notification: optionalBoolean(input.disableNotification) }
          : {}),
      });
      return {
        ok: true,
        action: "sent_message",
        chatId: String(targetChatId),
        messageId: sent.message_id,
        sizeChars: text.length,
        disableNotification: optionalBoolean(input.disableNotification) ?? false,
      };
    },
  };
}
