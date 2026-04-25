import type { Context } from "grammy";
import type { Clock } from "../shared/clock.js";
import type { InboundEvent, NormalizedAttachment, NormalizedEntity, TelegramCallbackEvent } from "./types.js";

function collectEntities(message: Record<string, unknown>): NormalizedEntity[] {
  const rawEntities = Array.isArray(message.entities)
    ? message.entities
    : Array.isArray(message.caption_entities)
      ? message.caption_entities
      : [];
  return rawEntities.flatMap((entity): NormalizedEntity[] => {
    if (!entity || typeof entity !== "object") {
      return [];
    }
    const record = entity as Record<string, unknown>;
    return [
      {
        type: typeof record.type === "string" ? record.type : "unknown",
        ...(typeof record.offset === "number" ? { offset: record.offset } : {}),
        ...(typeof record.length === "number" ? { length: record.length } : {}),
        ...(typeof record.url === "string" ? { value: record.url } : {}),
      },
    ];
  });
}

function collectAttachments(message: Record<string, unknown>): NormalizedAttachment[] {
  const attachments: NormalizedAttachment[] = [];
  const push = (kind: NormalizedAttachment["kind"], value: unknown) => {
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.file_id !== "string") {
      return;
    }
    attachments.push({
      kind,
      fileId: record.file_id,
      ...(typeof record.file_unique_id === "string" ? { fileUniqueId: record.file_unique_id } : {}),
      ...(typeof record.file_name === "string" ? { fileName: record.file_name } : {}),
      ...(typeof record.mime_type === "string" ? { mimeType: record.mime_type } : {}),
      ...(typeof record.file_size === "number" ? { fileSize: record.file_size } : {}),
      ...(typeof record.width === "number" ? { width: record.width } : {}),
      ...(typeof record.height === "number" ? { height: record.height } : {}),
      ...(typeof record.duration === "number" ? { duration: record.duration } : {}),
    });
  };

  const photoList = message.photo;
  if (Array.isArray(photoList) && photoList.length > 0) {
    const photos: unknown[] = photoList;
    const photo = photos[photos.length - 1];
    push("photo", photo);
  }
  push("document", message.document);
  push("audio", message.audio);
  push("voice", message.voice);
  push("video", message.video);
  push("sticker", message.sticker);
  push("animation", message.animation);
  return attachments;
}

/** Converts a grammY message context into the normalized inbound event shape. */
export function normalizeUpdate(params: { ctx: Context; botUsername?: string; clock: Clock }): InboundEvent | null {
  const message = params.ctx.message;
  if (!message) {
    return null;
  }
  const rawMessage = message as unknown as Record<string, unknown>;
  const chat =
    rawMessage.chat && typeof rawMessage.chat === "object" ? (rawMessage.chat as Record<string, unknown>) : null;
  if (!chat || (typeof chat.id !== "number" && typeof chat.id !== "string")) {
    return null;
  }
  const from =
    rawMessage.from && typeof rawMessage.from === "object" ? (rawMessage.from as Record<string, unknown>) : null;
  const text = typeof rawMessage.text === "string" ? rawMessage.text : undefined;
  const caption = typeof rawMessage.caption === "string" ? rawMessage.caption : undefined;
  const visibleText = text ?? caption ?? "";
  const lowerText = visibleText.toLowerCase();
  const botMention = params.botUsername ? `@${params.botUsername.toLowerCase()}` : undefined;
  const mentionsBot = botMention ? lowerText.includes(botMention) : false;
  const isCommand = visibleText.trimStart().startsWith("/");

  return {
    updateId: params.ctx.update.update_id,
    chatId: String(chat.id),
    chatType:
      chat.type === "private" || chat.type === "group" || chat.type === "supergroup" || chat.type === "channel"
        ? chat.type
        : "private",
    messageId: typeof rawMessage.message_id === "number" ? rawMessage.message_id : 0,
    ...(typeof rawMessage.message_thread_id === "number" ? { threadId: rawMessage.message_thread_id } : {}),
    ...(from && (typeof from.id === "number" || typeof from.id === "string") ? { fromUserId: String(from.id) } : {}),
    ...(from && typeof from.username === "string" ? { fromUsername: from.username } : {}),
    ...(text ? { text } : {}),
    ...(caption ? { caption } : {}),
    entities: collectEntities(rawMessage),
    attachments: collectAttachments(rawMessage),
    ...(rawMessage.reply_to_message &&
    typeof rawMessage.reply_to_message === "object" &&
    typeof (rawMessage.reply_to_message as Record<string, unknown>).message_id === "number"
      ? { replyToMessageId: (rawMessage.reply_to_message as Record<string, number>).message_id }
      : {}),
    mentionsBot,
    isCommand,
    arrivedAt: params.clock.now(),
  };
}

/** Converts a grammY callback query context into the normalized callback event shape. */
export function normalizeCallbackQuery(params: { ctx: Context; clock: Clock }): TelegramCallbackEvent | null {
  const callbackQuery = params.ctx.callbackQuery as unknown;
  if (!callbackQuery || typeof callbackQuery !== "object") {
    return null;
  }
  const rawCallback = callbackQuery as Record<string, unknown>;
  const data = typeof rawCallback.data === "string" ? rawCallback.data : undefined;
  const callbackQueryId = typeof rawCallback.id === "string" ? rawCallback.id : undefined;
  const message =
    rawCallback.message && typeof rawCallback.message === "object"
      ? (rawCallback.message as Record<string, unknown>)
      : undefined;
  const chat = message?.chat && typeof message.chat === "object" ? (message.chat as Record<string, unknown>) : null;
  if (!data || !callbackQueryId || !message || !chat || (typeof chat.id !== "number" && typeof chat.id !== "string")) {
    return null;
  }
  const from =
    rawCallback.from && typeof rawCallback.from === "object" ? (rawCallback.from as Record<string, unknown>) : null;
  return {
    updateId: params.ctx.update.update_id,
    callbackQueryId,
    chatId: String(chat.id),
    chatType:
      chat.type === "private" || chat.type === "group" || chat.type === "supergroup" || chat.type === "channel"
        ? chat.type
        : "private",
    messageId: typeof message.message_id === "number" ? message.message_id : 0,
    ...(typeof message.message_thread_id === "number" ? { threadId: message.message_thread_id } : {}),
    ...(from && (typeof from.id === "number" || typeof from.id === "string") ? { fromUserId: String(from.id) } : {}),
    ...(from && typeof from.username === "string" ? { fromUsername: from.username } : {}),
    data,
    arrivedAt: params.clock.now(),
  };
}
