import type { Api } from "grammy";
import { splitTelegramText } from "./formatting.js";
import type { InboundEvent } from "./types.js";

/** Sends a command reply, preserving Telegram topic and reply threading metadata. */
export async function sendReply(api: Api, event: InboundEvent, text: string): Promise<void> {
  for (const chunk of splitTelegramText(text)) {
    await api.sendMessage(event.chatId, chunk, {
      ...(typeof event.threadId === "number" ? { message_thread_id: event.threadId } : {}),
      reply_parameters: { message_id: event.messageId },
    });
  }
}
