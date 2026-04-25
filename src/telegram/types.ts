/** Normalized Telegram entity metadata used for command and mention handling. */
export type NormalizedEntity = {
  type: string;
  offset?: number;
  length?: number;
  value?: string;
};

/** Normalized Telegram file-like attachment metadata independent of update shape. */
export type NormalizedAttachment = {
  kind: "photo" | "document" | "audio" | "voice" | "video" | "sticker" | "animation" | "other";
  fileId: string;
  fileUniqueId?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  duration?: number;
};

/** Application-level Telegram event after update normalization. */
export type InboundEvent = {
  updateId: number;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  messageId: number;
  threadId?: number;
  fromUserId?: string;
  fromUsername?: string;
  text?: string;
  caption?: string;
  entities: NormalizedEntity[];
  attachments: NormalizedAttachment[];
  replyToMessageId?: number;
  mentionsBot: boolean;
  isCommand: boolean;
  arrivedAt: number;
};

/** Parsed slash command and remaining arguments from a Telegram message. */
export type ParsedCommand = {
  command: string;
  args: string[];
  raw: string;
};
