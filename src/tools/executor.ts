import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { HealthReporter } from "../app/health.js";
import type { CodexToolCall } from "../codex/tool-calls.js";
import type { Clock } from "../shared/clock.js";
import { getErrorMessage } from "../shared/errors.js";
import { ToolRegistry, ToolRegistryError, type ToolDefinition } from "./registry.js";
import {
  buildToolApprovalAuditRecord,
  evaluateToolApproval,
  type ToolApprovalDecision,
  type ToolApprovalStore,
} from "./approval.js";
import {
  buildToolApprovalPreview,
  createToolPolicyEngine,
  createToolRequestFingerprint,
  type ToolCallerRole,
  type ToolPolicy,
  type ToolPolicyEngine,
} from "./policy.js";

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

export type RestartServiceHandler = (params: {
  reason: string;
  delayMs: number;
}) => Promise<unknown> | unknown;

export type ToolExecutionContext = {
  definition: ToolDefinition;
  arguments: Record<string, unknown>;
  signal?: AbortSignal;
  sessionKey?: string;
  runId?: string;
  requestedByUserId?: string;
  chatId?: string;
  threadId?: number;
};

export type ToolHandler = (context: ToolExecutionContext) => Promise<unknown> | unknown;

export type ToolExecutorDependencies = {
  clock: Clock;
  health?: HealthReporter;
  handlers?: Partial<Record<string, ToolHandler>>;
  approvals?: ToolApprovalStore;
  policy?: ToolPolicyEngine;
  restartService?: RestartServiceHandler;
  defaultRestartDelayMs?: number;
  adminUserIds?: string[];
};

export type ToolExecutionOptions = {
  signal?: AbortSignal;
  sessionKey?: string;
  runId?: string;
  requestedByUserId?: string;
  chatId?: string;
  threadId?: number;
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
  private readonly policy: ToolPolicyEngine;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly deps: ToolExecutorDependencies,
  ) {
    this.policy = deps.policy ?? createToolPolicyEngine({ definitions: registry.listEnabled() });
    const health = deps.health;
    if (health) {
      this.handlers.set("mottbot_health_snapshot", () => health.snapshot());
    }
    if (deps.restartService) {
      this.handlers.set("mottbot_restart_service", ({ arguments: input }) => {
        const reason = typeof input.reason === "string" ? input.reason : "operator requested restart";
        const delaySeconds =
          typeof input.delaySeconds === "number" ? input.delaySeconds : undefined;
        return deps.restartService?.({
          reason,
          delayMs: delaySeconds ? delaySeconds * 1000 : (deps.defaultRestartDelayMs ?? 60_000),
        });
      });
    }
    for (const [name, handler] of Object.entries(deps.handlers ?? {})) {
      if (handler) {
        this.handlers.set(name, handler);
      }
    }
  }

  async execute(call: CodexToolCall, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult> {
    const startedAt = this.deps.clock.now();
    try {
      const definition = this.registry.resolve(call.name, { allowSideEffects: true });
      const input = this.registry.validateInput(call.name, call.arguments, { allowSideEffects: true });
      const role = this.callerRole(options.requestedByUserId);
      const policyDecision = this.policy.evaluate(definition, {
        role,
        chatId: options.chatId,
      });
      if (!policyDecision.allowed) {
        this.recordAudit({
          definition,
          decision: {
            allowed: false,
            code: policyDecision.code,
            message: policyDecision.message,
          },
          requestedAt: startedAt,
          decidedAt: this.deps.clock.now(),
          options,
        });
        return this.errorResult(call, startedAt, policyDecision.code, policyDecision.message);
      }
      if (definition.requiresAdmin && role !== "admin") {
        const decision: ToolApprovalDecision = {
          allowed: false,
          code: "role_denied",
          message: `Tool ${call.name} requires a configured admin user.`,
        };
        this.recordAudit({
          definition,
          decision,
          requestedAt: startedAt,
          decidedAt: this.deps.clock.now(),
          options,
        });
        return this.errorResult(call, startedAt, decision.code, decision.message);
      }
      const requestFingerprint = createToolRequestFingerprint({
        toolName: definition.name,
        arguments: input,
      });
      const previewText = buildToolApprovalPreview({
        definition,
        policy: policyDecision.policy,
        arguments: input,
      });
      if (policyDecision.policy.dryRun) {
        this.recordAudit({
          definition,
          decision: {
            allowed: true,
            code: "policy_allowed",
            message: `Tool ${call.name} is configured for dry run only.`,
          },
          requestedAt: startedAt,
          decidedAt: this.deps.clock.now(),
          options,
          requestFingerprint,
          previewText,
        });
        return this.successResult(
          call,
          startedAt,
          policyDecision.policy.maxOutputBytes,
          `Dry run only. No side effects executed.\n\n${previewText}`,
        );
      }
      const approval = this.evaluateApproval({
        definition,
        policy: policyDecision.policy,
        call,
        startedAt,
        options,
        requestFingerprint,
        previewText,
      });
      if (approval) {
        return approval;
      }
      const handler = this.handlers.get(call.name);
      if (!handler) {
        return this.errorResult(call, startedAt, "missing_handler", `No handler is registered for ${call.name}.`);
      }
      const handled = await this.runWithTimeout(
        () =>
          handler({
            definition,
            arguments: input,
            signal: options.signal,
            sessionKey: options.sessionKey,
            runId: options.runId,
            requestedByUserId: options.requestedByUserId,
            chatId: options.chatId,
            threadId: options.threadId,
          }),
        definition.timeoutMs,
      );
      if (!handled.ok) {
        return this.errorResult(call, startedAt, handled.code, handled.message);
      }
      return this.successResult(call, startedAt, policyDecision.policy.maxOutputBytes, handled.value);
    } catch (error) {
      const code = error instanceof ToolRegistryError ? error.code : "tool_failed";
      return this.errorResult(call, startedAt, code, getErrorMessage(error));
    }
  }

  private isAdmin(userId: string | undefined): boolean {
    return Boolean(userId && this.deps.adminUserIds?.includes(userId));
  }

  private callerRole(userId: string | undefined): ToolCallerRole {
    return this.isAdmin(userId) ? "admin" : "user";
  }

  private evaluateApproval(params: {
    definition: ToolDefinition;
    policy: ToolPolicy;
    call: CodexToolCall;
    startedAt: number;
    options: ToolExecutionOptions;
    requestFingerprint: string;
    previewText: string;
  }): ToolExecutionResult | undefined {
    if (!params.policy.requiresApproval) {
      if (params.definition.sideEffect !== "read_only") {
        this.recordAudit({
          definition: params.definition,
          decision: {
            allowed: true,
            code: "policy_allowed",
            message: `Tool ${params.definition.name} is allowed without per-call approval by policy.`,
          },
          requestedAt: params.startedAt,
          decidedAt: this.deps.clock.now(),
          options: params.options,
          requestFingerprint: params.requestFingerprint,
          previewText: params.previewText,
        });
      }
      return undefined;
    }
    const now = this.deps.clock.now();
    const activeApproval =
      params.options.sessionKey && this.deps.approvals
        ? this.deps.approvals.findActive({
            sessionKey: params.options.sessionKey,
            toolName: params.definition.name,
            now,
          })
        : undefined;
    const decision = evaluateToolApproval(params.definition, activeApproval, now, params.requestFingerprint);
    this.recordAudit({
      definition: params.definition,
      decision,
      requestedAt: params.startedAt,
      decidedAt: now,
      options: params.options,
      approval: activeApproval,
      requestFingerprint: params.requestFingerprint,
      previewText: params.previewText,
    });
    if (!decision.allowed) {
      const message =
        decision.code === "approval_required"
          ? `${decision.message}\n\nApproval preview:\n${params.previewText}`
          : decision.message;
      return this.errorResult(params.call, params.startedAt, decision.code, message);
    }
    if (activeApproval) {
      this.deps.approvals?.consume(activeApproval.id, now);
    }
    return undefined;
  }

  private recordAudit(params: {
    definition: ToolDefinition;
    decision: ToolApprovalDecision;
    requestedAt: number;
    decidedAt: number;
    options: ToolExecutionOptions;
    approval?: Parameters<typeof buildToolApprovalAuditRecord>[0]["approval"];
    requestFingerprint?: string;
    previewText?: string;
  }): void {
    this.deps.approvals?.recordAudit(
      buildToolApprovalAuditRecord({
        definition: params.definition,
        decision: params.decision,
        requestedAt: params.requestedAt,
        decidedAt: params.decidedAt,
        approval: params.approval,
        sessionKey: params.options.sessionKey,
        runId: params.options.runId,
        requestFingerprint: params.requestFingerprint,
        previewText: params.previewText,
      }),
    );
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
    maxOutputBytes: number,
    value: unknown,
  ): ToolExecutionResult {
    const text = formatToolOutput(value);
    const limited = limitUtf8Bytes(text, maxOutputBytes);
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
