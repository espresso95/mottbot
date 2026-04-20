import type { TranscriptMessage } from "../sessions/types.js";
import type { SessionMemory } from "../sessions/memory-store.js";

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "file"; data: string; mimeType: string; fileName?: string };

export type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string | PromptContentBlock[];
  timestamp: number;
};

export type BuiltPrompt = {
  systemPrompt: string;
  messages: PromptMessage[];
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are Mottbot, a Telegram-based coding and operator assistant.",
  "Reply concisely and clearly.",
  "Preserve code fences when returning code.",
  "Prefer direct answers over padding.",
].join("\n");

type TranscriptEnvelope = {
  attachments?: Array<{
    recordId?: string;
    kind?: string;
    fileId?: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    width?: number;
    height?: number;
    duration?: number;
    ingestionStatus?: string;
    ingestionReason?: string;
    downloadedBytes?: number;
    extraction?: {
      kind?: string;
      status?: string;
      reason?: string;
      textChars?: number;
      promptChars?: number;
      truncated?: boolean;
      language?: string;
      rowCount?: number;
      columnCount?: number;
      pageCount?: number;
    };
  }>;
};

function parseEnvelope(raw: string | undefined): TranscriptEnvelope | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as TranscriptEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

function condenseText(text: string, limit = 160): string {
  const condensed = text.replace(/\s+/g, " ").trim();
  if (condensed.length <= limit) {
    return condensed;
  }
  return `${condensed.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function sanitizeFileName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.replace(/\s+/g, " ").trim() || "unnamed";
}

function renderAttachmentMetadata(attachment: NonNullable<TranscriptEnvelope["attachments"]>[number]): string {
  const details = [
    typeof attachment.fileName === "string" ? `name: ${sanitizeFileName(attachment.fileName)}` : undefined,
    typeof attachment.mimeType === "string" ? `mime: ${attachment.mimeType}` : undefined,
    typeof attachment.fileSize === "number" ? `size: ${formatBytes(attachment.fileSize)}` : undefined,
    typeof attachment.width === "number" && typeof attachment.height === "number"
      ? `dimensions: ${attachment.width}x${attachment.height}`
      : undefined,
    typeof attachment.duration === "number" ? `duration: ${attachment.duration}s` : undefined,
    typeof attachment.ingestionStatus === "string" ? `ingestion: ${attachment.ingestionStatus}` : undefined,
    typeof attachment.ingestionReason === "string" ? `reason: ${attachment.ingestionReason}` : undefined,
    attachment.extraction ? renderExtractionMetadata(attachment.extraction) : undefined,
  ].filter(Boolean);
  return `- ${attachment.kind}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function renderExtractionMetadata(extraction: NonNullable<NonNullable<TranscriptEnvelope["attachments"]>[number]["extraction"]>): string {
  const details = [
    typeof extraction.kind === "string" ? extraction.kind : undefined,
    typeof extraction.status === "string" ? extraction.status : undefined,
    typeof extraction.reason === "string" ? extraction.reason : undefined,
    typeof extraction.language === "string" ? `language=${extraction.language}` : undefined,
    typeof extraction.promptChars === "number" ? `promptChars=${extraction.promptChars}` : undefined,
    typeof extraction.textChars === "number" ? `textChars=${extraction.textChars}` : undefined,
    extraction.truncated === true ? "truncated" : undefined,
    typeof extraction.rowCount === "number" ? `rows=${extraction.rowCount}` : undefined,
    typeof extraction.columnCount === "number" ? `columns=${extraction.columnCount}` : undefined,
    typeof extraction.pageCount === "number" ? `pages=${extraction.pageCount}` : undefined,
  ].filter(Boolean);
  return `extraction: ${details.join(" ")}`;
}

function renderTranscriptContent(entry: TranscriptMessage): string {
  const parts: string[] = [];
  if (entry.contentText?.trim()) {
    parts.push(entry.contentText.trim());
  }
  const attachments = parseEnvelope(entry.contentJson)?.attachments?.filter(
    (attachment) => attachment && typeof attachment.kind === "string" && typeof attachment.fileId === "string",
  );
  if (attachments && attachments.length > 0) {
    parts.push(
      [
        "Attachments:",
        ...attachments.map(renderAttachmentMetadata),
      ].join("\n"),
    );
  }
  return parts.join("\n\n").trim();
}

function buildSummary(entries: TranscriptMessage[]): string | undefined {
  const relevant = entries
    .filter((entry) => entry.role !== "tool")
    .map((entry) => ({
      role: entry.role,
      content: renderTranscriptContent(entry),
    }))
    .filter((entry) => entry.content.length > 0);
  if (relevant.length === 0) {
    return undefined;
  }
  const visible = relevant.slice(-12);
  const lines = visible.map((entry) => `- ${entry.role}: ${condenseText(entry.content)}`);
  const omitted = relevant.length - visible.length;
  return [
    omitted > 0 ? `Omitted ${omitted} earlier turns.` : undefined,
    "Earlier conversation summary:",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
}

function memoryPromptRank(memory: SessionMemory): number {
  if (memory.source === "auto_summary") {
    return 90;
  }
  if (memory.pinned) {
    return 0;
  }
  switch (memory.scope) {
    case "project":
      return 10;
    case "personal":
      return 20;
    case "group":
      return 30;
    case "chat":
      return 40;
    case "session":
      return 50;
  }
}

function buildMemoryMessage(memories: SessionMemory[]): PromptMessage | undefined {
  const orderedMemories = [...memories].sort((left, right) => {
    const rank = memoryPromptRank(left) - memoryPromptRank(right);
    if (rank !== 0) {
      return rank;
    }
    return left.updatedAt - right.updatedAt;
  });
  const visible = orderedMemories
    .filter((memory) => !memory.archivedAt)
    .map((memory) => {
      const content = memory.contentText.trim();
      if (!content) {
        return undefined;
      }
      const attributes = [
        memory.scope,
        memory.source === "auto_summary" ? "auto" : undefined,
        memory.pinned ? "pinned" : undefined,
      ].filter(Boolean);
      return `[${attributes.join(", ")}] ${content}`;
    })
    .filter(Boolean)
    .slice(0, 20);
  if (visible.length === 0) {
    return undefined;
  }
  return {
    role: "system",
    content: ["Long-term memory approved for this chat:", ...visible.map((memory) => `- ${memory}`)].join("\n"),
    timestamp: orderedMemories.reduce((latest, memory) => Math.max(latest, memory.updatedAt), 0),
  };
}

export function buildPrompt(params: {
  history: TranscriptMessage[];
  systemPrompt?: string;
  historyLimit?: number;
  memories?: SessionMemory[];
}): BuiltPrompt {
  const historyLimit = params.historyLimit ?? 24;
  const olderHistory =
    params.history.length > historyLimit ? params.history.slice(0, -historyLimit) : [];
  const trimmedHistory = params.history.slice(-historyLimit);
  const messages: PromptMessage[] = [];
  const memoryMessage = buildMemoryMessage(params.memories ?? []);
  if (memoryMessage) {
    messages.push(memoryMessage);
  }
  const summary = buildSummary(olderHistory);
  if (summary) {
    messages.push({
      role: "system",
      content: summary,
      timestamp: olderHistory[olderHistory.length - 1]?.createdAt ?? 0,
    });
  }
  messages.push(
    ...trimmedHistory.flatMap((entry): PromptMessage[] => {
      const content = renderTranscriptContent(entry);
      if (!content) {
        return [];
      }
      if (entry.role === "tool") {
        return [];
      }
      return [
        {
          role: entry.role === "system" ? "system" : entry.role === "assistant" ? "assistant" : "user",
          content,
          timestamp: entry.createdAt,
        },
      ];
    }),
  );
  return {
    systemPrompt: params.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    messages,
  };
}
