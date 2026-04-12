import type { DatabaseClient } from "../db/client.js";
import type { Logger } from "../shared/logger.js";
import { getErrorMessage } from "../shared/errors.js";
import { createId } from "../shared/ids.js";
import { resolveCodexModel } from "./provider.js";
import type { CodexResolvedAuth } from "./types.js";

export type TransportMode = "auto" | "sse" | "websocket";

type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
};

type StreamParams = {
  sessionKey: string;
  modelRef: string;
  transport: TransportMode;
  auth: CodexResolvedAuth;
  systemPrompt?: string;
  messages: PromptMessage[];
  signal?: AbortSignal;
  fastMode?: boolean;
  onStart?: () => Promise<void> | void;
  onTextDelta?: (delta: string) => Promise<void> | void;
  onThinkingDelta?: (delta: string) => Promise<void> | void;
};

export type CodexStreamResult = {
  text: string;
  thinking?: string;
  usage?: Record<string, unknown>;
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
    try {
      return await this.runStream({
        ...params,
        transport: preferredTransport === "auto" ? "websocket" : preferredTransport,
        requestIdentity,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      const canFallback =
        params.transport === "auto" &&
        preferredTransport !== "sse" &&
        /websocket|ws|socket/i.test(message);
      if (!canFallback) {
        throw error;
      }
      this.logger.warn({ sessionKey: params.sessionKey, error: message }, "WebSocket transport failed. Falling back to SSE.");
      this.writeTransportState(params.sessionKey, {
        websocketDegradedUntil: Date.now() + 60_000,
        lastTransport: "sse",
      });
      return await this.runStream({
        ...params,
        transport: "sse",
        requestIdentity,
      });
    }
  }

  private async runStream(
    params: StreamParams & { transport: Exclude<TransportMode, "auto">; requestIdentity: string },
  ): Promise<CodexStreamResult> {
    const piAi = await import("@mariozechner/pi-ai");
    const model = resolveCodexModel(params.modelRef, params.transport);
    const context = {
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      messages: params.messages,
    };
    const options = {
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
    let started = false;

    const maybeStream = await piAi.streamSimple(model as never, context as never, options as never);
    if (isAsyncIterable(maybeStream)) {
      for await (const event of maybeStream) {
        if (!started && event && typeof event === "object") {
          const type = (event as { type?: unknown }).type;
          if (type === "start" || type === "text_start") {
            started = true;
            await params.onStart?.();
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
        if (type === "done") {
          const done = event as { message?: unknown; usage?: unknown };
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
      this.writeTransportState(params.sessionKey, {
        websocketDegradedUntil: null,
        lastTransport: params.transport,
      });
      return {
        text,
        ...(thinking ? { thinking } : {}),
        ...(usage ? { usage } : {}),
        transport: params.transport,
        requestIdentity: params.requestIdentity,
      };
    }

    const completed = (await piAi.completeSimple(model as never, context as never, options as never)) as any;
    text = collectMessageText(completed?.message);
    usage =
      completed?.usage && typeof completed.usage === "object"
        ? (completed.usage as unknown as Record<string, unknown>)
        : undefined;
    this.writeTransportState(params.sessionKey, {
      websocketDegradedUntil: null,
      lastTransport: params.transport,
    });
    return {
      text,
      ...(usage ? { usage } : {}),
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
}
