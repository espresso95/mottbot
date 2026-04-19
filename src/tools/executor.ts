import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { HealthReporter } from "../app/health.js";
import type { CodexToolCall } from "../codex/tool-calls.js";
import type { Clock } from "../shared/clock.js";
import { getErrorMessage } from "../shared/errors.js";
import { ToolRegistry, ToolRegistryError, type ToolDefinition } from "./registry.js";

export type ToolExecutionResult = {
  toolCallId: string;
  toolName: string;
  contentText: string;
  isError: boolean;
  elapsedMs: number;
  outputBytes: number;
  truncated: boolean;
  errorCode?: string;
};

export type ToolExecutionContext = {
  definition: ToolDefinition;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
};

export type ToolHandler = (context: ToolExecutionContext) => Promise<unknown> | unknown;

export type ToolExecutorDependencies = {
  clock: Clock;
  health?: HealthReporter;
  handlers?: Partial<Record<string, ToolHandler>>;
};

type TimedHandlerResult =
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

export class ToolExecutor {
  private readonly handlers = new Map<string, ToolHandler>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly deps: ToolExecutorDependencies,
  ) {
    const health = deps.health;
    if (health) {
      this.handlers.set("mottbot_health_snapshot", () => health.snapshot());
    }
    for (const [name, handler] of Object.entries(deps.handlers ?? {})) {
      if (handler) {
        this.handlers.set(name, handler);
      }
    }
  }

  async execute(call: CodexToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const startedAt = this.deps.clock.now();
    try {
      const definition = this.registry.resolve(call.name);
      const input = this.registry.validateInput(call.name, call.arguments);
      const handler = this.handlers.get(call.name);
      if (!handler) {
        return this.errorResult(call, startedAt, "missing_handler", `No handler is registered for ${call.name}.`);
      }
      const handled = await this.runWithTimeout(
        () =>
          handler({
            definition,
            arguments: input,
            signal,
          }),
        definition.timeoutMs,
      );
      if (!handled.ok) {
        return this.errorResult(call, startedAt, handled.code, handled.message);
      }
      return this.successResult(call, startedAt, definition, handled.value);
    } catch (error) {
      const code = error instanceof ToolRegistryError ? error.code : "tool_failed";
      return this.errorResult(call, startedAt, code, getErrorMessage(error));
    }
  }

  toToolResultMessage(result: ToolExecutionResult): ToolResultMessage {
    return {
      role: "toolResult",
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      content: [{ type: "text", text: result.contentText }],
      details: {
        elapsedMs: result.elapsedMs,
        outputBytes: result.outputBytes,
        truncated: result.truncated,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      },
      isError: result.isError,
      timestamp: this.deps.clock.now(),
    };
  }

  private async runWithTimeout(run: () => Promise<unknown> | unknown, timeoutMs: number): Promise<TimedHandlerResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race<TimedHandlerResult>([
        Promise.resolve()
          .then(run)
          .then((value) => ({ ok: true, value })),
        new Promise<TimedHandlerResult>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              ok: false,
              code: "tool_timeout",
              message: `Tool exceeded ${timeoutMs} ms timeout.`,
            });
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      return {
        ok: false,
        code: "tool_failed",
        message: getErrorMessage(error),
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private successResult(
    call: CodexToolCall,
    startedAt: number,
    definition: ToolDefinition,
    value: unknown,
  ): ToolExecutionResult {
    const text = formatToolOutput(value);
    const limited = limitUtf8Bytes(text, definition.maxOutputBytes);
    return {
      toolCallId: call.id,
      toolName: call.name,
      contentText: limited.text,
      isError: false,
      elapsedMs: Math.max(0, this.deps.clock.now() - startedAt),
      outputBytes: limited.bytes,
      truncated: limited.truncated,
    };
  }

  private errorResult(call: CodexToolCall, startedAt: number, code: string, message: string): ToolExecutionResult {
    const contentText = `Tool ${call.name} failed: ${message}`;
    return {
      toolCallId: call.id,
      toolName: call.name,
      contentText,
      isError: true,
      elapsedMs: Math.max(0, this.deps.clock.now() - startedAt),
      outputBytes: Buffer.byteLength(contentText, "utf8"),
      truncated: false,
      errorCode: code,
    };
  }
}

function formatToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? "null";
}

function limitUtf8Bytes(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return {
      text,
      bytes,
      truncated: false,
    };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const sliced = text.slice(0, low);
  const suffix = `\n[tool output truncated to ${maxBytes} bytes]`;
  const textWithSuffix =
    Buffer.byteLength(sliced + suffix, "utf8") <= maxBytes ? sliced + suffix : sliced;
  return {
    text: textWithSuffix,
    bytes: Buffer.byteLength(textWithSuffix, "utf8"),
    truncated: true,
  };
}
