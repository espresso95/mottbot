import type { TranscriptMessage } from "../sessions/types.js";

export type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
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

export function buildPrompt(params: {
  history: TranscriptMessage[];
  systemPrompt?: string;
  historyLimit?: number;
}): BuiltPrompt {
  const trimmedHistory = params.history.slice(-(params.historyLimit ?? 24));
  const messages: PromptMessage[] = trimmedHistory.flatMap((entry): PromptMessage[] => {
    if (!entry.contentText) {
      return [];
    }
    if (entry.role === "tool") {
      return [];
    }
    return [
      {
        role: entry.role === "system" ? "system" : entry.role === "assistant" ? "assistant" : "user",
        content: entry.contentText,
        timestamp: entry.createdAt,
      },
    ];
  });
  return {
    systemPrompt: params.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    messages,
  };
}
