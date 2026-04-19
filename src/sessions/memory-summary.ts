import type { TranscriptMessage } from "./types.js";

function condense(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

export function buildAutomaticMemorySummary(params: {
  messages: TranscriptMessage[];
  maxChars: number;
}): string | undefined {
  const turns = params.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role,
      text: message.contentText?.trim() ?? "",
    }))
    .filter((message) => message.text.length > 0);
  if (turns.length < 2) {
    return undefined;
  }
  const perTurnLimit = Math.max(40, Math.floor((params.maxChars - 48) / Math.min(turns.length, 12)));
  const body = turns
    .slice(-12)
    .map((turn) => `${turn.role}: ${condense(turn.text, perTurnLimit)}`)
    .join(" | ");
  return condense(`Automatic recent conversation summary: ${body}`, params.maxChars);
}
