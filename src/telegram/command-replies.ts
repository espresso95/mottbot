import type { Api } from "grammy";
import { splitTelegramText } from "./formatting.js";
import type { InboundEvent, TelegramCallbackEvent } from "./types.js";

/** Telegram inline keyboard shape used by command replies. */
export type TelegramInlineKeyboard = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

/** Additional send options for Telegram command replies. */
export type SendReplyOptions = {
  replyMarkup?: TelegramInlineKeyboard;
};

type ReplyTarget = Pick<InboundEvent | TelegramCallbackEvent, "chatId" | "messageId" | "threadId">;

/** Sends a command reply, preserving Telegram topic and reply threading metadata. */
export async function sendReply(
  api: Api,
  event: ReplyTarget,
  text: string,
  options: SendReplyOptions = {},
): Promise<void> {
  const chunks = splitTelegramText(text);
  for (const [index, chunk] of chunks.entries()) {
    await api.sendMessage(event.chatId, chunk, {
      ...(typeof event.threadId === "number" ? { message_thread_id: event.threadId } : {}),
      reply_parameters: { message_id: event.messageId },
      ...(index === 0 && options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
    });
  }
}
