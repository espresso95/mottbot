import fs from "node:fs/promises";
import path from "node:path";
import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import { createId } from "../shared/ids.js";
import {
  classifyAttachmentForExtraction,
  extractAttachmentText,
  mayInspectAttachmentBytes,
  type AttachmentExtractionKind,
  type AttachmentExtractionMetadata,
  type ExtractedAttachmentText,
} from "./file-extraction.js";
import type { NormalizedAttachment } from "./types.js";

export type { ExtractedAttachmentText } from "./file-extraction.js";

/** Native provider input built from a downloaded Telegram attachment. */
export type NativeAttachmentInput =
  | {
      type: "image";
      data: string;
      mimeType: string;
    }
  | {
      type: "file";
      data: string;
      mimeType: string;
      fileName?: string;
    };

/** Transcript-safe attachment metadata persisted with ingestion and extraction outcomes. */
export type TranscriptAttachmentMetadata = NormalizedAttachment & {
  recordId?: string;
  ingestionStatus: "metadata_only" | "native_input" | "extracted_text" | "skipped";
  ingestionReason?: string;
  downloadedBytes?: number;
  extraction?: AttachmentExtractionMetadata;
};

/** Prepared attachment payloads returned before a model run starts. */
export type AttachmentPreparation = {
  transcriptAttachments: TranscriptAttachmentMetadata[];
  nativeInputs: NativeAttachmentInput[];
  extractedTexts: ExtractedAttachmentText[];
  cachePaths: string[];
};

/** Attachment preparation interface used by run orchestration and test doubles. */
export type AttachmentIngestor = {
  prepare(params: {
    attachments: NormalizedAttachment[];
    allowNativeImages: boolean;
    allowNativeFiles: boolean;
    signal?: AbortSignal;
  }): Promise<AttachmentPreparation>;
  cleanup(preparation: AttachmentPreparation): Promise<void>;
};

/** Operator-safe attachment ingestion failure with a stable error code. */
class AttachmentIngestionError extends Error {
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
const NATIVE_FILE_MIME_BY_KIND: Record<AttachmentExtractionKind, string> = {
  code: "text/plain",
  csv: "text/csv",
  markdown: "text/markdown",
  pdf: "application/pdf",
  text: "text/plain",
  tsv: "text/tab-separated-values",
};

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

function nativeFileMimeType(params: { mimeType?: string; extractionKind: AttachmentExtractionKind }): string {
  return params.mimeType ?? NATIVE_FILE_MIME_BY_KIND[params.extractionKind];
}

function cacheFileName(attachment: NormalizedAttachment, telegramFile: TelegramFile): string {
  const sourceName = attachment.fileName ?? telegramFile.file_path ?? attachment.fileId;
  return `${createId()}-${sanitizeFileName(path.basename(sourceName))}`;
}

async function readResponseBody(params: { response: Response; maxBytes: number }): Promise<Buffer> {
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

  const reader = params.response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const chunk: Buffer = Buffer.from(next.value);
    totalBytes += chunk.byteLength;
    if (totalBytes > params.maxBytes) {
      throw new AttachmentIngestionError("attachment.too_large", "Attachment is larger than the configured limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Attachment ingestor that records metadata only and performs no downloads. */
export class NoopAttachmentIngestor implements AttachmentIngestor {
  async prepare(params: {
    attachments: NormalizedAttachment[];
    allowNativeImages?: boolean;
    allowNativeFiles?: boolean;
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

/** Downloads Telegram files and prepares native or extracted attachment content for model prompts. */
export class TelegramAttachmentIngestor implements AttachmentIngestor {
  constructor(
    private readonly api: Api,
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async prepare(params: {
    attachments: NormalizedAttachment[];
    allowNativeImages: boolean;
    allowNativeFiles: boolean;
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
    let downloadedTotalBytes = 0;
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
        const nativeFileKind = extractionCandidate?.kind;
        const shouldTryNativeImage = params.allowNativeImages && isImageMimeType(mimeType);
        const shouldTryNativeFile =
          params.allowNativeFiles &&
          attachment.kind === "document" &&
          !isImageMimeType(mimeType) &&
          nativeFileKind !== undefined;
        const shouldDownload =
          shouldTryNativeImage || shouldTryNativeFile || Boolean(extractionCandidate) || canInspectBytes;

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
        if (
          typeof telegramFileSize === "number" &&
          downloadedTotalBytes + telegramFileSize > this.config.attachments.maxTotalBytes
        ) {
          throw new AttachmentIngestionError(
            "attachment.too_large",
            "Attachments exceed the configured combined size limit.",
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
          maxBytes: Math.min(
            this.config.attachments.maxFileBytes,
            this.config.attachments.maxTotalBytes - downloadedTotalBytes,
          ),
        });
        downloadedTotalBytes += buffer.byteLength;
        if (downloadedTotalBytes > this.config.attachments.maxTotalBytes) {
          throw new AttachmentIngestionError(
            "attachment.too_large",
            "Attachments exceed the configured combined size limit.",
          );
        }
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
        if (shouldTryNativeFile && nativeFileKind) {
          nativeInputs.push({
            type: "file",
            data: buffer.toString("base64"),
            mimeType: nativeFileMimeType({
              mimeType,
              extractionKind: nativeFileKind,
            }),
            ...(attachment.fileName || telegramFile.file_path
              ? {
                  fileName: sanitizeFileName(
                    path.basename(attachment.fileName ?? telegramFile.file_path ?? "attachment"),
                  ),
                }
              : {}),
          });
          transcriptAttachments.push({
            ...baseMetadata,
            ...(mimeType ? { mimeType } : {}),
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
