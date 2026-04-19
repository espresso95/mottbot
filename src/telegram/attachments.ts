import fs from "node:fs/promises";
import path from "node:path";
import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import { createId } from "../shared/ids.js";
import {
  classifyAttachmentForExtraction,
  extractAttachmentText,
  mayInspectAttachmentBytes,
  type AttachmentExtractionMetadata,
  type ExtractedAttachmentText,
} from "./file-extraction.js";
import type { NormalizedAttachment } from "./types.js";

export type { ExtractedAttachmentText } from "./file-extraction.js";

export type NativeAttachmentInput = {
  type: "image";
  data: string;
  mimeType: string;
};

export type TranscriptAttachmentMetadata = NormalizedAttachment & {
  recordId?: string;
  ingestionStatus: "metadata_only" | "native_input" | "extracted_text" | "skipped";
  ingestionReason?: string;
  downloadedBytes?: number;
  extraction?: AttachmentExtractionMetadata;
};

export type AttachmentPreparation = {
  transcriptAttachments: TranscriptAttachmentMetadata[];
  nativeInputs: NativeAttachmentInput[];
  extractedTexts: ExtractedAttachmentText[];
  cachePaths: string[];
};

export type AttachmentIngestor = {
  prepare(params: {
    attachments: NormalizedAttachment[];
    allowNativeImages: boolean;
    signal?: AbortSignal;
  }): Promise<AttachmentPreparation>;
  cleanup(preparation: AttachmentPreparation): Promise<void>;
};

export class AttachmentIngestionError extends Error {
  constructor(
    readonly code:
      | "attachment.missing_file_id"
      | "attachment.too_many"
      | "attachment.too_large"
      | "attachment.missing_file_path"
      | "attachment.download_failed",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentIngestionError";
  }
}

type TelegramFile = {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
};

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "attachment";
}

function inferMimeType(attachment: NormalizedAttachment, filePath?: string): string | undefined {
  if (attachment.mimeType) {
    return attachment.mimeType;
  }
  const extension = filePath ? path.extname(filePath).toLowerCase() : "";
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (attachment.kind === "photo") {
    return "image/jpeg";
  }
  return undefined;
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType && IMAGE_MIME_TYPES.has(mimeType));
}

function cacheFileName(attachment: NormalizedAttachment, telegramFile: TelegramFile): string {
  const sourceName = attachment.fileName ?? telegramFile.file_path ?? attachment.fileId;
  return `${createId()}-${sanitizeFileName(path.basename(sourceName))}`;
}

async function readResponseBody(params: {
  response: Response;
  maxBytes: number;
}): Promise<Buffer> {
  const contentLength = params.response.headers.get("content-length");
  if (contentLength && Number(contentLength) > params.maxBytes) {
    throw new AttachmentIngestionError("attachment.too_large", "Attachment is larger than the configured limit.");
  }
  if (!params.response.body) {
    const buffer = Buffer.from(await params.response.arrayBuffer());
    if (buffer.byteLength > params.maxBytes) {
      throw new AttachmentIngestionError("attachment.too_large", "Attachment is larger than the configured limit.");
    }
    return buffer;
  }

  const reader = params.response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const chunk = Buffer.from(next.value);
    totalBytes += chunk.byteLength;
    if (totalBytes > params.maxBytes) {
      throw new AttachmentIngestionError("attachment.too_large", "Attachment is larger than the configured limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class NoopAttachmentIngestor implements AttachmentIngestor {
  async prepare(params: {
    attachments: NormalizedAttachment[];
  }): Promise<AttachmentPreparation> {
    return {
      transcriptAttachments: params.attachments.map((attachment) => ({
        ...attachment,
        ingestionStatus: "metadata_only",
      })),
      nativeInputs: [],
      extractedTexts: [],
      cachePaths: [],
    };
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up.
  }
}

export class TelegramAttachmentIngestor implements AttachmentIngestor {
  constructor(
    private readonly api: Api,
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async prepare(params: {
    attachments: NormalizedAttachment[];
    allowNativeImages: boolean;
    signal?: AbortSignal;
  }): Promise<AttachmentPreparation> {
    if (params.attachments.length > this.config.attachments.maxPerMessage) {
      throw new AttachmentIngestionError(
        "attachment.too_many",
        `Too many attachments. Maximum is ${this.config.attachments.maxPerMessage} per message.`,
      );
    }

    const transcriptAttachments: TranscriptAttachmentMetadata[] = [];
    const nativeInputs: NativeAttachmentInput[] = [];
    const extractedTexts: ExtractedAttachmentText[] = [];
    const cachePaths: string[] = [];
    const extractionBudget = {
      remainingChars: this.config.attachments.maxExtractedTextCharsTotal,
    };
    const extractionLimits = {
      maxTextCharsPerFile: this.config.attachments.maxExtractedTextCharsPerFile,
      csvPreviewRows: this.config.attachments.csvPreviewRows,
      csvPreviewColumns: this.config.attachments.csvPreviewColumns,
      pdfMaxPages: this.config.attachments.pdfMaxPages,
    };

    try {
      for (const attachment of params.attachments) {
        if (!attachment.fileId) {
          throw new AttachmentIngestionError("attachment.missing_file_id", "Attachment is missing a Telegram file ID.");
        }
        const baseMetadata: TranscriptAttachmentMetadata = {
          ...attachment,
          ingestionStatus: "metadata_only",
        };
        if (attachment.kind !== "document" && !(params.allowNativeImages && attachment.kind === "photo")) {
          transcriptAttachments.push({
            ...baseMetadata,
            ingestionStatus: "skipped",
            ingestionReason:
              attachment.kind === "photo" ? "model_does_not_support_images" : "unsupported_attachment_type",
          });
          continue;
        }
        const telegramFile = (await this.api.getFile(attachment.fileId)) as TelegramFile;
        const mimeType = inferMimeType(attachment, telegramFile.file_path);
        const extractionCandidate = classifyAttachmentForExtraction({
          attachment,
          mimeType,
          filePath: telegramFile.file_path,
        });
        const canInspectBytes = mayInspectAttachmentBytes({
          attachment,
          mimeType,
        });
        const shouldTryNativeImage = params.allowNativeImages && isImageMimeType(mimeType);
        const shouldDownload = shouldTryNativeImage || Boolean(extractionCandidate) || canInspectBytes;

        if (!shouldDownload) {
          transcriptAttachments.push({
            ...baseMetadata,
            ingestionStatus: "skipped",
            ingestionReason:
              isImageMimeType(mimeType) && !params.allowNativeImages
                ? "model_does_not_support_images"
                : "unsupported_attachment_type",
          });
          continue;
        }
        const telegramFileSize = telegramFile.file_size ?? attachment.fileSize;
        if (typeof telegramFileSize === "number" && telegramFileSize > this.config.attachments.maxFileBytes) {
          throw new AttachmentIngestionError(
            "attachment.too_large",
            `Attachment ${attachment.fileName ?? attachment.kind} exceeds the configured size limit.`,
          );
        }
        if (!telegramFile.file_path) {
          throw new AttachmentIngestionError("attachment.missing_file_path", "Telegram did not return a file path.");
        }

        const url = `https://api.telegram.org/file/bot${this.config.telegram.botToken}/${telegramFile.file_path}`;
        const response = await this.fetchImpl(url, { signal: params.signal });
        if (!response.ok) {
          throw new AttachmentIngestionError("attachment.download_failed", "Telegram attachment download failed.");
        }
        const buffer = await readResponseBody({
          response,
          maxBytes: this.config.attachments.maxFileBytes,
        });
        await fs.mkdir(this.config.attachments.cacheDir, { recursive: true });
        const cachePath = path.join(this.config.attachments.cacheDir, cacheFileName(attachment, telegramFile));
        await fs.writeFile(cachePath, buffer);
        cachePaths.push(cachePath);
        if (shouldTryNativeImage && mimeType) {
          nativeInputs.push({
            type: "image",
            data: buffer.toString("base64"),
            mimeType,
          });
          transcriptAttachments.push({
            ...baseMetadata,
            mimeType,
            fileSize: telegramFileSize ?? buffer.byteLength,
            ingestionStatus: "native_input",
            downloadedBytes: buffer.byteLength,
          });
          continue;
        }

        const extraction = await extractAttachmentText({
          attachment,
          mimeType,
          filePath: telegramFile.file_path,
          buffer,
          limits: extractionLimits,
          budget: extractionBudget,
        });
        if (extraction?.extractedText) {
          extractedTexts.push(extraction.extractedText);
        }
        transcriptAttachments.push({
          ...baseMetadata,
          ...(mimeType ? { mimeType } : {}),
          fileSize: telegramFileSize ?? buffer.byteLength,
          ingestionStatus: extraction?.extractedText ? "extracted_text" : "skipped",
          ingestionReason: extraction ? undefined : "unsupported_attachment_type",
          downloadedBytes: buffer.byteLength,
          ...(extraction ? { extraction: extraction.metadata } : {}),
        });
      }
    } catch (error) {
      await this.cleanup({ transcriptAttachments, nativeInputs, extractedTexts, cachePaths });
      throw error;
    }

    return {
      transcriptAttachments,
      nativeInputs,
      extractedTexts,
      cachePaths,
    };
  }

  async cleanup(preparation: AttachmentPreparation): Promise<void> {
    await Promise.all(
      preparation.cachePaths.map(async (cachePath) => {
        await fs.rm(cachePath, { force: true });
      }),
    );
  }
}
