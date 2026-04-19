import type { NativeAttachmentInput } from "../telegram/attachments.js";
import type { PromptContentBlock, PromptMessage } from "./prompt-builder.js";

function toBlocks(content: string | PromptContentBlock[]): PromptContentBlock[] {
  if (Array.isArray(content)) {
    return content;
  }
  return content ? [{ type: "text", text: content }] : [];
}

export function appendNativeAttachmentsToLatestUserMessage(params: {
  messages: PromptMessage[];
  nativeInputs: NativeAttachmentInput[];
}): PromptMessage[] {
  if (params.nativeInputs.length === 0) {
    return params.messages;
  }
  const targetIndex = params.messages.findLastIndex((message) => message.role === "user");
  if (targetIndex === -1) {
    return params.messages;
  }
  return params.messages.map((message, index) => {
    if (index !== targetIndex) {
      return message;
    }
    return {
      ...message,
      content: [
        ...toBlocks(message.content),
        ...params.nativeInputs.map((input): PromptContentBlock => ({
          type: "image",
          data: input.data,
          mimeType: input.mimeType,
        })),
      ],
    };
  });
}
