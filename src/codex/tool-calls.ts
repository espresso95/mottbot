import type { AssistantMessage } from "@mariozechner/pi-ai";

export type CodexToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type CodexToolCallProgress = {
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function hasAssistantShape(value: unknown): value is AssistantMessage {
  return isRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

export function normalizeCodexToolCall(value: unknown): CodexToolCall | undefined {
  if (!isRecord(value) || value.type !== "toolCall") {
    return undefined;
  }
  if (typeof value.id !== "string" || !value.id.trim()) {
    return undefined;
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    arguments: normalizeArguments(value.arguments),
  };
}

export function normalizeCodexToolCallProgress(value: unknown): CodexToolCallProgress | undefined {
  if (!isRecord(value) || value.type !== "toolCall") {
    return undefined;
  }
  const progress: CodexToolCallProgress = {};
  if (typeof value.id === "string" && value.id.trim()) {
    progress.id = value.id;
  }
  if (typeof value.name === "string" && value.name.trim()) {
    progress.name = value.name;
  }
  if (isRecord(value.arguments)) {
    progress.arguments = value.arguments;
  }
  return Object.keys(progress).length > 0 ? progress : undefined;
}

export function collectCodexToolCallsFromMessage(message: unknown): CodexToolCall[] {
  if (!hasAssistantShape(message)) {
    return [];
  }
  return message.content.flatMap((content) => {
    const toolCall = normalizeCodexToolCall(content);
    return toolCall ? [toolCall] : [];
  });
}

export function assistantMessageFromUnknown(message: unknown): AssistantMessage | undefined {
  return hasAssistantShape(message) ? message : undefined;
}

export function collectCodexToolCallsFromEvent(event: unknown): CodexToolCall[] {
  if (!isRecord(event)) {
    return [];
  }
  const direct = normalizeCodexToolCall(event.toolCall);
  if (direct) {
    return [direct];
  }
  const partial = partialContentBlock(event);
  const partialToolCall = normalizeCodexToolCall(partial);
  return partialToolCall ? [partialToolCall] : [];
}

export function collectCodexToolProgressFromEvent(event: unknown): CodexToolCallProgress | undefined {
  if (!isRecord(event)) {
    return undefined;
  }
  const direct = normalizeCodexToolCallProgress(event.toolCall);
  if (direct) {
    return direct;
  }
  return normalizeCodexToolCallProgress(partialContentBlock(event));
}

function partialContentBlock(event: Record<string, unknown>): unknown {
  if (typeof event.contentIndex !== "number" || !Number.isInteger(event.contentIndex)) {
    return undefined;
  }
  if (!isRecord(event.partial) || !Array.isArray(event.partial.content)) {
    return undefined;
  }
  return event.partial.content[event.contentIndex];
}
