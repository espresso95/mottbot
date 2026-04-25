import type { ExtractedAttachmentText, NativeAttachmentInput } from "../telegram/attachments.js";
import type { PromptContentBlock, PromptMessage } from "./prompt-builder.js";

function toBlocks(content: string | PromptContentBlock[]): PromptContentBlock[] {
  if (Array.isArray(content)) {
    return content;
  }
  return content ? [{ type: "text", text: content }] : [];
}

function sanitizeLabel(value: string | undefined): string {
  return value?.split(/[\\/]/).at(-1)?.replace(/\s+/g, " ").trim() || "unnamed";
}

function renderExtractedAttachment(input: ExtractedAttachmentText, index: number): string {
  const details = [
    `name=${sanitizeLabel(input.fileName)}`,
    `type=${input.kind}`,
    input.mimeType ? `mime=${input.mimeType}` : undefined,
    input.language ? `language=${input.language}` : undefined,
    input.rowCount !== undefined ? `rows=${input.rowCount}` : undefined,
    input.columnCount !== undefined ? `columns=${input.columnCount}` : undefined,
    input.pageCount !== undefined ? `pages=${input.pageCount}` : undefined,
    input.truncated ? "truncated=true" : undefined,
  ].filter(Boolean);
  return [`Attachment ${index + 1} extracted text (${details.join(", ")}):`, "```text", input.text, "```"].join("\n");
}

/** Appends native and extracted attachment content to the latest user prompt message. */
export function appendPreparedAttachmentsToLatestUserMessage(params: {
  messages: PromptMessage[];
  nativeInputs: NativeAttachmentInput[];
  extractedTexts: ExtractedAttachmentText[];
}): PromptMessage[] {
  if (params.nativeInputs.length === 0 && params.extractedTexts.length === 0) {
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
        ...(params.extractedTexts.length > 0
          ? [
              {
                type: "text" as const,
                text: params.extractedTexts.map(renderExtractedAttachment).join("\n\n"),
              },
            ]
          : []),
        ...params.nativeInputs.map(
          (input): PromptContentBlock =>
            input.type === "image"
              ? {
                  type: "image",
                  data: input.data,
                  mimeType: input.mimeType,
                }
              : {
                  type: "file",
                  data: input.data,
                  mimeType: input.mimeType,
                  ...(input.fileName ? { fileName: sanitizeLabel(input.fileName) } : {}),
                },
        ),
      ],
    };
  });
}
