import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { FormatError, InvalidPDFException, PasswordException, PDFParse } from "pdf-parse";
import { getErrorMessage } from "../shared/errors.js";
import type { NormalizedAttachment } from "./types.js";

/** Supported extraction strategy selected for a Telegram document. */
export type AttachmentExtractionKind = "text" | "markdown" | "pdf" | "code" | "csv" | "tsv";

/** Outcome status for attachment text extraction. */
type AttachmentExtractionStatus = "extracted" | "skipped" | "failed";

/** Transcript metadata describing what happened during attachment extraction. */
export type AttachmentExtractionMetadata = {
  kind: AttachmentExtractionKind;
  status: AttachmentExtractionStatus;
  reason?: string;
  textChars?: number;
  promptChars?: number;
  truncated?: boolean;
  language?: string;
  rowCount?: number;
  columnCount?: number;
  pageCount?: number;
};

/** Text payload extracted from an attachment and ready for prompt insertion. */
export type ExtractedAttachmentText = {
  kind: AttachmentExtractionKind;
  fileName?: string;
  mimeType?: string;
  language?: string;
  text: string;
  textChars: number;
  promptChars: number;
  truncated: boolean;
  rowCount?: number;
  columnCount?: number;
  pageCount?: number;
};

/** Per-file parser and prompt-size limits for attachment extraction. */
type FileExtractionLimits = {
  maxTextCharsPerFile: number;
  csvPreviewRows: number;
  csvPreviewColumns: number;
  pdfMaxPages: number;
};

/** Remaining shared prompt-character budget across attachments in one message. */
type FileExtractionBudget = {
  remainingChars: number;
};

type FileClassification = {
  kind: AttachmentExtractionKind;
  language?: string;
};

/** Result of attempting to extract text, with metadata always available. */
type FileExtractionResult =
  | {
      metadata: AttachmentExtractionMetadata;
      extractedText: ExtractedAttachmentText;
    }
  | {
      metadata: AttachmentExtractionMetadata;
      extractedText?: undefined;
    };

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-ndjson",
  "application/x-sh",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);

const MARKDOWN_MIME_TYPES = new Set(["text/markdown", "text/x-markdown"]);
const CSV_MIME_TYPES = new Set(["text/csv", "application/csv"]);
const TSV_MIME_TYPES = new Set(["text/tab-separated-values"]);
const PDF_MIME_TYPES = new Set(["application/pdf"]);

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const TEXT_EXTENSIONS = new Set([
  ".conf",
  ".env",
  ".ini",
  ".json",
  ".jsonl",
  ".log",
  ".text",
  ".toml",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const CODE_EXTENSIONS = new Map<string, string>([
  [".bash", "bash"],
  [".c", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cs", "csharp"],
  [".css", "css"],
  [".go", "go"],
  [".h", "c"],
  [".hpp", "cpp"],
  [".html", "html"],
  [".java", "java"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".kt", "kotlin"],
  [".lua", "lua"],
  [".mjs", "javascript"],
  [".php", "php"],
  [".ps1", "powershell"],
  [".py", "python"],
  [".rb", "ruby"],
  [".rs", "rust"],
  [".sh", "shell"],
  [".sql", "sql"],
  [".swift", "swift"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".vue", "vue"],
  [".zsh", "zsh"],
]);

const CODE_BASENAMES = new Map<string, string>([
  ["dockerfile", "dockerfile"],
  ["makefile", "make"],
  ["rakefile", "ruby"],
]);

const KNOWN_BINARY_MIME_PREFIXES = ["audio/", "image/", "video/"];
const KNOWN_BINARY_MIME_TYPES = new Set([
  "application/gzip",
  "application/octet-stream",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-bzip2",
  "application/x-gzip",
  "application/x-rar-compressed",
  "application/zip",
]);

function basename(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const clean = value.split(/[\\/]/).at(-1)?.trim();
  return clean || undefined;
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const [mime] = value?.toLowerCase().split(";") ?? [];
  return mime?.trim() || undefined;
}

function extensionFrom(params: { attachment: NormalizedAttachment; filePath?: string }): string {
  return path.extname(basename(params.attachment.fileName) ?? basename(params.filePath) ?? "").toLowerCase();
}

/** Classifies whether a Telegram document can be extracted based on MIME type and filename. */
export function classifyAttachmentForExtraction(params: {
  attachment: NormalizedAttachment;
  mimeType?: string;
  filePath?: string;
}): FileClassification | undefined {
  if (params.attachment.kind !== "document") {
    return undefined;
  }
  const mimeType = normalizeMimeType(params.mimeType ?? params.attachment.mimeType);
  const extension = extensionFrom(params);
  const baseName = basename(params.attachment.fileName ?? params.filePath)?.toLowerCase();

  if (mimeType && PDF_MIME_TYPES.has(mimeType)) {
    return { kind: "pdf" };
  }
  if (extension === ".pdf") {
    return { kind: "pdf" };
  }
  if ((mimeType && CSV_MIME_TYPES.has(mimeType)) || extension === ".csv") {
    return { kind: "csv" };
  }
  if ((mimeType && TSV_MIME_TYPES.has(mimeType)) || extension === ".tsv") {
    return { kind: "tsv" };
  }
  if ((mimeType && MARKDOWN_MIME_TYPES.has(mimeType)) || MARKDOWN_EXTENSIONS.has(extension)) {
    return { kind: "markdown", language: "markdown" };
  }
  const language = CODE_EXTENSIONS.get(extension) ?? (baseName ? CODE_BASENAMES.get(baseName) : undefined);
  if (language) {
    return { kind: "code", language };
  }
  if ((mimeType && (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType))) || TEXT_EXTENSIONS.has(extension)) {
    return { kind: "text" };
  }
  return undefined;
}

/** Returns whether unknown document bytes may be sampled to detect safe text content. */
export function mayInspectAttachmentBytes(params: { attachment: NormalizedAttachment; mimeType?: string }): boolean {
  if (params.attachment.kind !== "document") {
    return false;
  }
  const mimeType = normalizeMimeType(params.mimeType ?? params.attachment.mimeType);
  if (!mimeType) {
    return true;
  }
  if (KNOWN_BINARY_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return false;
  }
  return !KNOWN_BINARY_MIME_TYPES.has(mimeType);
}

function decodeUtf8(buffer: Buffer): string | undefined {
  if (buffer.includes(0)) {
    return undefined;
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(buffer).replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
}

function classifyByBytes(buffer: Buffer): FileClassification | undefined {
  const text = decodeUtf8(buffer);
  if (!text) {
    return undefined;
  }
  const sample = text.slice(0, 4096);
  if (!sample.trim()) {
    return { kind: "text" };
  }
  const controlChars = [...sample].filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== "\n" && char !== "\r" && char !== "\t";
  }).length;
  if (controlChars / sample.length > 0.02) {
    return undefined;
  }
  return { kind: "text" };
}

function normalizeTextForPrompt(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function truncateForBudget(params: { text: string; limits: FileExtractionLimits; budget: FileExtractionBudget }): {
  text: string;
  promptChars: number;
  truncated: boolean;
} {
  const maxChars = Math.min(params.limits.maxTextCharsPerFile, params.budget.remainingChars);
  if (maxChars <= 0) {
    return { text: "", promptChars: 0, truncated: params.text.length > 0 };
  }
  if (params.text.length <= maxChars) {
    return { text: params.text, promptChars: params.text.length, truncated: false };
  }
  const suffix = "\n[Attachment text truncated.]";
  const sliceLength = Math.max(0, maxChars - suffix.length);
  const text = `${params.text.slice(0, sliceLength).trimEnd()}${suffix}`;
  return { text, promptChars: text.length, truncated: true };
}

function extracted(params: {
  attachment: NormalizedAttachment;
  classification: FileClassification;
  mimeType?: string;
  text: string;
  sourceTextChars?: number;
  limits: FileExtractionLimits;
  budget: FileExtractionBudget;
  rowCount?: number;
  columnCount?: number;
  pageCount?: number;
}): FileExtractionResult {
  const sourceText = normalizeTextForPrompt(params.text);
  const textChars = params.sourceTextChars ?? sourceText.length;
  const limited = truncateForBudget({
    text: sourceText,
    limits: params.limits,
    budget: params.budget,
  });
  params.budget.remainingChars = Math.max(0, params.budget.remainingChars - limited.promptChars);
  if (!limited.text) {
    return {
      metadata: {
        kind: params.classification.kind,
        status: "skipped",
        reason: "text_extraction_budget_exhausted",
        textChars,
        promptChars: 0,
        truncated: textChars > 0,
        ...(params.classification.language ? { language: params.classification.language } : {}),
        ...(params.rowCount !== undefined ? { rowCount: params.rowCount } : {}),
        ...(params.columnCount !== undefined ? { columnCount: params.columnCount } : {}),
        ...(params.pageCount !== undefined ? { pageCount: params.pageCount } : {}),
      },
    };
  }
  return {
    metadata: {
      kind: params.classification.kind,
      status: "extracted",
      textChars,
      promptChars: limited.promptChars,
      truncated: limited.truncated,
      ...(params.classification.language ? { language: params.classification.language } : {}),
      ...(params.rowCount !== undefined ? { rowCount: params.rowCount } : {}),
      ...(params.columnCount !== undefined ? { columnCount: params.columnCount } : {}),
      ...(params.pageCount !== undefined ? { pageCount: params.pageCount } : {}),
    },
    extractedText: {
      kind: params.classification.kind,
      ...(params.attachment.fileName ? { fileName: params.attachment.fileName } : {}),
      ...(params.mimeType ? { mimeType: params.mimeType } : {}),
      ...(params.classification.language ? { language: params.classification.language } : {}),
      text: limited.text,
      textChars,
      promptChars: limited.promptChars,
      truncated: limited.truncated,
      ...(params.rowCount !== undefined ? { rowCount: params.rowCount } : {}),
      ...(params.columnCount !== undefined ? { columnCount: params.columnCount } : {}),
      ...(params.pageCount !== undefined ? { pageCount: params.pageCount } : {}),
    },
  };
}

function failed(kind: AttachmentExtractionKind, reason: string): FileExtractionResult {
  return {
    metadata: {
      kind,
      status: "failed",
      reason,
    },
  };
}

function formatCell(value: unknown): string {
  const raw = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
  const text = raw.replace(/\s+/g, " ").replaceAll("|", "\\|").trim();
  return text.length > 80 ? `${text.slice(0, 77).trimEnd()}...` : text;
}

function extractDelimited(params: {
  attachment: NormalizedAttachment;
  classification: FileClassification;
  mimeType?: string;
  buffer: Buffer;
  limits: FileExtractionLimits;
  budget: FileExtractionBudget;
}): FileExtractionResult {
  const decoded = decodeUtf8(params.buffer);
  if (!decoded) {
    return failed(params.classification.kind, "invalid_utf8");
  }
  try {
    const delimiter = params.classification.kind === "tsv" ? "\t" : ",";
    const records = parseCsv(decoded, {
      bom: true,
      delimiter,
      relax_column_count: true,
      skip_empty_lines: false,
      to_line: params.limits.csvPreviewRows,
      max_record_size: 128 * 1024,
    });
    const previewRows = records.slice(0, params.limits.csvPreviewRows);
    const maxColumns = previewRows.reduce((max, row) => Math.max(max, row.length), 0);
    const previewColumns = Math.min(maxColumns, params.limits.csvPreviewColumns);
    if (previewRows.length === 0 || previewColumns === 0) {
      return failed(params.classification.kind, "empty_table");
    }
    const rows = previewRows.map(
      (row) => `| ${Array.from({ length: previewColumns }, (_, index) => formatCell(row[index])).join(" | ")} |`,
    );
    const separator = `| ${Array.from({ length: previewColumns }, () => "---").join(" | ")} |`;
    const table = [rows[0], separator, ...rows.slice(1)].filter(Boolean).join("\n");
    return extracted({
      attachment: params.attachment,
      classification: params.classification,
      mimeType: params.mimeType,
      text: [
        `${params.classification.kind.toUpperCase()} preview: ${previewRows.length} row(s), ${previewColumns} column(s).`,
        table,
      ].join("\n"),
      sourceTextChars: decoded.length,
      limits: params.limits,
      budget: params.budget,
      rowCount: previewRows.length,
      columnCount: previewColumns,
    });
  } catch (error) {
    return failed(params.classification.kind, `csv_parse_failed: ${getErrorMessage(error)}`);
  }
}

function classifyPdfFailure(error: unknown): string {
  if (error instanceof PasswordException) {
    return "pdf_encrypted_or_password_protected";
  }
  if (error instanceof InvalidPDFException || error instanceof FormatError) {
    return "pdf_unreadable";
  }
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes("password") || message.includes("encrypted")) {
    return "pdf_encrypted_or_password_protected";
  }
  return "pdf_unreadable";
}

async function extractPdf(params: {
  attachment: NormalizedAttachment;
  classification: FileClassification;
  mimeType?: string;
  buffer: Buffer;
  limits: FileExtractionLimits;
  budget: FileExtractionBudget;
}): Promise<FileExtractionResult> {
  const parser = new PDFParse({ data: Buffer.from(params.buffer) });
  try {
    const result = await parser.getText({
      first: params.limits.pdfMaxPages,
      pageJoiner: "\n",
    });
    const text = normalizeTextForPrompt(result.text);
    if (!text) {
      return failed("pdf", "pdf_no_extractable_text");
    }
    return extracted({
      attachment: params.attachment,
      classification: params.classification,
      mimeType: params.mimeType,
      text,
      limits: params.limits,
      budget: params.budget,
      pageCount: result.pages.length,
    });
  } catch (error) {
    return failed("pdf", classifyPdfFailure(error));
  } finally {
    await parser.destroy();
  }
}

/** Extracts bounded prompt text from supported document bytes while updating the shared budget. */
export async function extractAttachmentText(params: {
  attachment: NormalizedAttachment;
  mimeType?: string;
  filePath?: string;
  buffer: Buffer;
  limits: FileExtractionLimits;
  budget: FileExtractionBudget;
}): Promise<FileExtractionResult | undefined> {
  const classification =
    classifyAttachmentForExtraction(params) ??
    (mayInspectAttachmentBytes(params) ? classifyByBytes(params.buffer) : undefined);
  if (!classification) {
    return undefined;
  }
  if (classification.kind === "pdf") {
    return await extractPdf({
      attachment: params.attachment,
      classification,
      mimeType: params.mimeType,
      buffer: params.buffer,
      limits: params.limits,
      budget: params.budget,
    });
  }
  if (classification.kind === "csv" || classification.kind === "tsv") {
    return extractDelimited({
      attachment: params.attachment,
      classification,
      mimeType: params.mimeType,
      buffer: params.buffer,
      limits: params.limits,
      budget: params.budget,
    });
  }
  const decoded = decodeUtf8(params.buffer);
  if (!decoded) {
    return failed(classification.kind, "invalid_utf8");
  }
  return extracted({
    attachment: params.attachment,
    classification,
    mimeType: params.mimeType,
    text: decoded,
    limits: params.limits,
    budget: params.budget,
  });
}
