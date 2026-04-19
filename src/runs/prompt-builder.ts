import type { TranscriptMessage } from "../sessions/types.js";

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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
    kind?: string;
    fileId?: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    width?: number;
    height?: number;
    duration?: number;
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
    typeof attachment.fileId === "string" ? `Telegram file id: ${attachment.fileId}` : undefined,
  ].filter(Boolean);
  return `- ${attachment.kind}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
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

export function buildPrompt(params: {
  history: TranscriptMessage[];
  systemPrompt?: string;
  historyLimit?: number;
}): BuiltPrompt {
  const historyLimit = params.historyLimit ?? 24;
  const olderHistory =
    params.history.length > historyLimit ? params.history.slice(0, -historyLimit) : [];
  const trimmedHistory = params.history.slice(-historyLimit);
  const messages: PromptMessage[] = [];
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
