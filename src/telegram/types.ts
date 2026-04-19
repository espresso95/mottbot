export type NormalizedEntity = {
  type: string;
  offset?: number;
  length?: number;
  value?: string;
};

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

export type ParsedCommand = {
  command: string;
  args: string[];
  raw: string;
};
