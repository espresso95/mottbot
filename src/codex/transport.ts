import type { DatabaseClient } from "../db/client.js";
import type { Logger } from "../shared/logger.js";
import { getErrorMessage } from "../shared/errors.js";
import { createId } from "../shared/ids.js";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  SimpleStreamOptions,
  TextContent,
  Tool,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type { PromptContentBlock, PromptMessage } from "../runs/prompt-builder.js";
import type { ModelToolDeclaration } from "../tools/registry.js";
import { resolveCodexModel } from "./provider.js";
import {
  assistantMessageFromUnknown,
  collectCodexToolCallsFromEvent,
  collectCodexToolCallsFromMessage,
  collectCodexToolProgressFromEvent,
  type CodexToolCall,
  type CodexToolCallProgress,
} from "./tool-calls.js";
import type { CodexResolvedAuth } from "./types.js";

export type TransportMode = "auto" | "sse" | "websocket";

type StreamParams = {
  sessionKey: string;
  modelRef: string;
  transport: TransportMode;
  auth: CodexResolvedAuth;
  systemPrompt?: string;
  messages: PromptMessage[];
  tools?: ModelToolDeclaration[];
  extraContextMessages?: Message[];
  signal?: AbortSignal;
  fastMode?: boolean;
  onStart?: () => Promise<void> | void;
  onTextDelta?: (delta: string) => Promise<void> | void;
  onThinkingDelta?: (delta: string) => Promise<void> | void;
  onToolCallStart?: (toolCall: CodexToolCallProgress) => Promise<void> | void;
  onToolCallEnd?: (toolCall: CodexToolCall) => Promise<void> | void;
};

export type CodexStreamResult = {
  text: string;
  thinking?: string;
  usage?: Record<string, unknown>;
  toolCalls?: CodexToolCall[];
  assistantMessage?: AssistantMessage;
  stopReason?: string;
  transport: "websocket" | "sse";
  requestIdentity: string;
};

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

function collectMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const record = item as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function contentToText(content: string | PromptContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function toAssistantContent(content: string | PromptContentBlock[]): TextContent[] {
  const text = contentToText(content);
  return text ? [{ type: "text", text }] : [];
}

function toUserContent(content: string | PromptContentBlock[]): UserMessage["content"] {
  if (typeof content === "string") {
    return content;
  }
  return content.map((block): TextContent | ImageContent => {
    if (block.type === "image") {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    return { type: "text", text: block.text };
  });
}

function toPiAiTools(tools: ModelToolDeclaration[] | undefined): Tool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as Tool["parameters"],
  }));
}

function buildPiAiContext(params: {
  systemPrompt?: string;
  messages: PromptMessage[];
  model: ReturnType<typeof resolveCodexModel>;
  tools?: ModelToolDeclaration[];
  extraMessages?: Message[];
}): Context {
  const systemParts = [
    params.systemPrompt?.trim(),
    ...params.messages
      .filter((message) => message.role === "system")
      .map((message) => contentToText(message.content))
      .filter(Boolean),
  ].filter(Boolean);
  const messages = params.messages.flatMap((message): Message[] => {
    if (message.role === "system") {
      return [];
    }
    if (message.role === "user") {
      const content = toUserContent(message.content);
      if ((typeof content === "string" && !content.trim()) || (Array.isArray(content) && content.length === 0)) {
        return [];
      }
      return [{ role: "user", content, timestamp: message.timestamp }];
    }
    const content = toAssistantContent(message.content);
    if (content.length === 0) {
      return [];
    }
    const assistant: AssistantMessage = {
      role: "assistant",
      content,
      api: params.model.api,
      provider: params.model.provider,
      model: params.model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: message.timestamp,
    };
    return [assistant];
  });
  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n\n") } : {}),
    messages: [...messages, ...(params.extraMessages ?? [])],
    ...(params.tools && params.tools.length > 0 ? { tools: toPiAiTools(params.tools) } : {}),
  };
}

export class CodexTransport {
  constructor(
    private readonly database: DatabaseClient,
    private readonly logger: Logger,
  ) {}

  async stream(params: StreamParams): Promise<CodexStreamResult> {
    const degraded = this.readDegradedUntil(params.sessionKey);
    const preferredTransport =
      params.transport === "auto" && degraded && degraded > Date.now() ? "sse" : params.transport;
    const requestIdentity = createId();
    let sawProgress = false;
    const wrappedParams: StreamParams = {
      ...params,
      onStart: async () => {
        sawProgress = true;
        await params.onStart?.();
      },
      onTextDelta: async (delta) => {
        sawProgress = true;
        await params.onTextDelta?.(delta);
      },
      onThinkingDelta: async (delta) => {
        sawProgress = true;
        await params.onThinkingDelta?.(delta);
      },
      onToolCallStart: async (toolCall) => {
        sawProgress = true;
        await params.onToolCallStart?.(toolCall);
      },
      onToolCallEnd: async (toolCall) => {
        sawProgress = true;
        await params.onToolCallEnd?.(toolCall);
      },
    };
    try {
      const selectedTransport = preferredTransport === "auto" ? "websocket" : preferredTransport;
      const result = await this.runStream({
        ...wrappedParams,
        transport: selectedTransport,
        requestIdentity,
      });
      this.recordSuccessfulTransport(params.sessionKey, selectedTransport, degraded);
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      const canFallback =
        params.transport === "auto" &&
        preferredTransport !== "sse" &&
        !sawProgress &&
        /websocket|ws|socket/i.test(message);
      if (!canFallback) {
        throw error;
      }
      this.logger.warn({ sessionKey: params.sessionKey, error: message }, "WebSocket transport failed. Falling back to SSE.");
      const degradedUntil = Date.now() + 60_000;
      this.writeTransportState(params.sessionKey, {
        websocketDegradedUntil: degradedUntil,
        lastTransport: "sse",
      });
      const result = await this.runStream({
        ...wrappedParams,
        transport: "sse",
        requestIdentity,
      });
      this.recordSuccessfulTransport(params.sessionKey, "sse", degradedUntil);
      return result;
    }
  }

  private async runStream(
    params: StreamParams & { transport: Exclude<TransportMode, "auto">; requestIdentity: string },
  ): Promise<CodexStreamResult> {
    const piAi = await import("@mariozechner/pi-ai");
    const model = resolveCodexModel(params.modelRef, params.transport);
    const context = buildPiAiContext({
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      model,
      tools: params.tools,
      extraMessages: params.extraContextMessages,
    });
    const options: SimpleStreamOptions = {
      apiKey: params.auth.apiKey,
      signal: params.signal,
      onPayload: (payload: unknown) => {
        if (!payload || typeof payload !== "object") {
          return;
        }
        const next = payload as Record<string, unknown>;
        if (params.fastMode && next.service_tier === undefined) {
          next.service_tier = "priority";
        }
        const text = next.text && typeof next.text === "object" ? (next.text as Record<string, unknown>) : {};
        next.text = { ...text, verbosity: text.verbosity ?? "medium" };
      },
    };

    let text = "";
    let thinking = "";
    let usage: Record<string, unknown> | undefined;
    let assistantMessage: AssistantMessage | undefined;
    let stopReason: string | undefined;
    const toolCalls: CodexToolCall[] = [];
    let started = false;
    const ensureStarted = async () => {
      if (started) {
        return;
      }
      started = true;
      await params.onStart?.();
    };
    const recordToolCall = async (toolCall: CodexToolCall) => {
      if (toolCalls.some((existing) => existing.id === toolCall.id)) {
        return;
      }
      toolCalls.push(toolCall);
      await params.onToolCallEnd?.(toolCall);
    };

    const maybeStream = await piAi.streamSimple(model, context, options);
    if (isAsyncIterable(maybeStream)) {
      for await (const event of maybeStream) {
        if (!started && event && typeof event === "object") {
          const type = (event as { type?: unknown }).type;
          if (
            type === "start" ||
            type === "text_start" ||
            type === "text_delta" ||
            type === "thinking_delta" ||
            type === "toolcall_start" ||
            type === "toolcall_delta" ||
            type === "toolcall_end" ||
            type === "done"
          ) {
            await ensureStarted();
          }
        }
        if (!event || typeof event !== "object") {
          continue;
        }
        const type = (event as { type?: unknown }).type;
        if (type === "text_delta" && typeof (event as { delta?: unknown }).delta === "string") {
          const delta = (event as { delta: string }).delta;
          text += delta;
          await params.onTextDelta?.(delta);
          continue;
        }
        if (type === "thinking_delta" && typeof (event as { delta?: unknown }).delta === "string") {
          const delta = (event as { delta: string }).delta;
          thinking += delta;
          await params.onThinkingDelta?.(delta);
          continue;
        }
        if (type === "toolcall_start" || type === "toolcall_delta") {
          const progress = collectCodexToolProgressFromEvent(event);
          if (progress) {
            await params.onToolCallStart?.(progress);
          }
          continue;
        }
        if (type === "toolcall_end") {
          for (const toolCall of collectCodexToolCallsFromEvent(event)) {
            await recordToolCall(toolCall);
          }
          continue;
        }
        if (type === "done") {
          const done = event as { message?: unknown; usage?: unknown; reason?: unknown };
          assistantMessage = assistantMessageFromUnknown(done.message);
          stopReason = typeof done.reason === "string" ? done.reason : assistantMessage?.stopReason;
          for (const toolCall of collectCodexToolCallsFromMessage(done.message)) {
            await recordToolCall(toolCall);
          }
          if (!text && done.message) {
            text = collectMessageText(done.message);
          }
          if (done.usage && typeof done.usage === "object") {
            usage = done.usage as Record<string, unknown>;
          }
          break;
        }
        if (type === "error") {
          const errorEvent = event as {
            error?: { errorMessage?: unknown; content?: unknown };
          };
          const errorMessage =
            typeof errorEvent.error?.errorMessage === "string"
              ? errorEvent.error.errorMessage
              : collectMessageText(errorEvent.error);
          throw new Error(errorMessage || "Codex stream failed.");
        }
      }
      return {
        text,
        ...(thinking ? { thinking } : {}),
        ...(usage ? { usage } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(assistantMessage ? { assistantMessage } : {}),
        ...(stopReason ? { stopReason } : {}),
        transport: params.transport,
        requestIdentity: params.requestIdentity,
      };
    }

    await ensureStarted();
    const completed = await piAi.completeSimple(model, context, options);
    assistantMessage = assistantMessageFromUnknown(completed);
    stopReason = assistantMessage?.stopReason;
    text = collectMessageText(completed);
    toolCalls.push(...collectCodexToolCallsFromMessage(completed));
    usage =
      completed?.usage && typeof completed.usage === "object"
        ? (completed.usage as unknown as Record<string, unknown>)
        : undefined;
    return {
      text,
      ...(usage ? { usage } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(assistantMessage ? { assistantMessage } : {}),
      ...(stopReason ? { stopReason } : {}),
      transport: params.transport,
      requestIdentity: params.requestIdentity,
    };
  }

  private readDegradedUntil(sessionKey: string): number | undefined {
    const row = this.database.db
      .prepare<unknown[], { websocket_degraded_until: number | null }>(
        "select websocket_degraded_until from transport_state where session_key = ?",
      )
      .get(sessionKey);
    return row?.websocket_degraded_until ?? undefined;
  }

  private writeTransportState(
    sessionKey: string,
    state: { websocketDegradedUntil: number | null; lastTransport: "sse" | "websocket" },
  ): void {
    this.database.db
      .prepare(
        `insert into transport_state (session_key, websocket_degraded_until, last_transport, updated_at)
         values (?, ?, ?, ?)
         on conflict(session_key) do update set
           websocket_degraded_until = excluded.websocket_degraded_until,
           last_transport = excluded.last_transport,
           updated_at = excluded.updated_at`,
      )
      .run(sessionKey, state.websocketDegradedUntil, state.lastTransport, Date.now());
  }

  private recordSuccessfulTransport(
    sessionKey: string,
    transport: "sse" | "websocket",
    degradedUntil?: number,
  ): void {
    this.writeTransportState(sessionKey, {
      websocketDegradedUntil:
        transport === "websocket"
          ? null
          : typeof degradedUntil === "number" && degradedUntil > Date.now()
            ? degradedUntil
            : null,
      lastTransport: transport,
    });
  }
}
