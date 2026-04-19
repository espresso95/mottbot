import { describe, expect, it, vi } from "vitest";
import { ToolExecutor } from "../../src/tools/executor.js";
import { createRuntimeToolRegistry, ToolRegistry, type ToolDefinition } from "../../src/tools/registry.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { FakeClock, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";
import { OperatorDiagnostics } from "../../src/app/diagnostics.js";
import { createOperatorDiagnosticToolHandlers } from "../../src/tools/operator-diagnostic-handlers.js";
import { createTelegramReactionToolHandlers } from "../../src/tools/telegram-reaction-handlers.js";
import { createToolPolicyEngine, createToolRequestFingerprint } from "../../src/tools/policy.js";

function readOnlyTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "lookup_value",
    description: "Lookup a test value.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    maxOutputBytes: 4_000,
    sideEffect: "read_only",
    enabled: true,
    ...overrides,
  };
}

describe("ToolExecutor", () => {
  it("executes the built-in read-only health snapshot", async () => {
    const stores = createStores();
    try {
      const executor = new ToolExecutor(new ToolRegistry(), {
        clock: stores.clock,
        health: stores.health,
      });

      const result = await executor.execute({
        id: "call-1",
        name: "mottbot_health_snapshot",
        arguments: {},
      });

      expect(result.isError).toBe(false);
      expect(result.toolName).toBe("mottbot_health_snapshot");
      expect(result.contentText).toContain('"status"');
      expect(result.outputBytes).toBeGreaterThan(0);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("executes read-only operator diagnostic tools", async () => {
    const stores = createStores();
    try {
      stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      stores.runs.create({
        sessionKey: "tg:dm:chat-1:user:user-1",
        modelRef: "openai-codex/gpt-5.4",
        profileId: "openai-codex:default",
      });
      const diagnostics = new OperatorDiagnostics(stores.config, stores.database, stores.clock);
      const executor = new ToolExecutor(new ToolRegistry(), {
        clock: stores.clock,
        handlers: createOperatorDiagnosticToolHandlers(diagnostics),
        adminUserIds: ["admin-1"],
      });

      const result = await executor.execute({
        id: "call-runs",
        name: "mottbot_recent_runs",
        arguments: { limit: 1 },
      }, {
        requestedByUserId: "admin-1",
      });

      expect(result.isError).toBe(false);
      expect(result.contentText).toContain("openai-codex/gpt-5.4");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("returns tool-result messages for provider continuation", async () => {
    const clock = new FakeClock(123);
    const executor = new ToolExecutor(new ToolRegistry([readOnlyTool()]), {
      clock,
      handlers: {
        lookup_value: () => "value",
      },
    });

    const result = await executor.execute({
      id: "call-2",
      name: "lookup_value",
      arguments: {},
    });

    expect(executor.toToolResultMessage(result)).toEqual({
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "lookup_value",
      content: [{ type: "text", text: "value" }],
      details: {
        elapsedMs: 0,
        outputBytes: 5,
        truncated: false,
      },
      isError: false,
      timestamp: 123,
    });
  });

  it("returns errors for unknown, disabled, or invalid tools", async () => {
    const executor = new ToolExecutor(new ToolRegistry([readOnlyTool({ enabled: false })]), {
      clock: new FakeClock(),
    });

    const result = await executor.execute({
      id: "call-3",
      name: "lookup_value",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("disabled_tool");
    expect(result.contentText).toContain("disabled");
  });

  it("enforces handler timeouts", async () => {
    const executor = new ToolExecutor(new ToolRegistry([readOnlyTool({ timeoutMs: 1 })]), {
      clock: new FakeClock(),
      handlers: {
        lookup_value: () => new Promise((resolve) => setTimeout(resolve, 25)),
      },
    });

    const result = await executor.execute({
      id: "call-4",
      name: "lookup_value",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("tool_timeout");
  });

  it("truncates oversized output", async () => {
    const executor = new ToolExecutor(new ToolRegistry([readOnlyTool({ maxOutputBytes: 8 })]), {
      clock: new FakeClock(),
      handlers: {
        lookup_value: () => "abcdefghijklmnop",
      },
    });

    const result = await executor.execute({
      id: "call-5",
      name: "lookup_value",
      arguments: {},
    });

    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(8);
  });

  it("denies execution when per-tool policy rejects the caller", async () => {
    const stores = createStores();
    try {
      stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const definition = readOnlyTool();
      const registry = new ToolRegistry([definition]);
      const approvals = new ToolApprovalStore(stores.database, stores.clock);
      const policy = createToolPolicyEngine({
        definitions: [definition],
        overrides: {
          lookup_value: {
            allowedRoles: ["admin"],
          },
        },
      });
      const executor = new ToolExecutor(registry, {
        clock: stores.clock,
        approvals,
        policy,
        handlers: {
          lookup_value: () => "value",
        },
      });

      const result = await executor.execute({
        id: "call-policy-denied",
        name: "lookup_value",
        arguments: {},
      }, {
        sessionKey: "tg:dm:chat-1:user:user-1",
        requestedByUserId: "user-1",
      });

      expect(result.isError).toBe(true);
      expect(result.errorCode).toBe("role_denied");
      expect(approvals.listAudit({ decisionCode: "role_denied" })).toHaveLength(1);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("uses policy output caps and dry-run mode", async () => {
    const definition = readOnlyTool();
    const registry = new ToolRegistry([definition]);
    const policy = createToolPolicyEngine({
      definitions: [definition],
      overrides: {
        lookup_value: {
          dryRun: true,
          maxOutputBytes: 32,
        },
      },
    });
    const handler = vi.fn(() => "should not run");
    const executor = new ToolExecutor(registry, {
      clock: new FakeClock(),
      policy,
      handlers: {
        lookup_value: handler,
      },
    });

    const result = await executor.execute({
      id: "call-dry-run",
      name: "lookup_value",
      arguments: {},
    });

    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(32);
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires and consumes approval before executing side-effecting tools", async () => {
    const stores = createStores();
    try {
      stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const run = stores.runs.create({
        sessionKey: "tg:dm:chat-1:user:user-1",
        modelRef: "openai-codex/gpt-5.4",
        profileId: "openai-codex:default",
      });
      const approvals = new ToolApprovalStore(stores.database, stores.clock);
      const registry = new ToolRegistry(
        [
          readOnlyTool({
            name: "mottbot_restart_service",
            description: "Restart service.",
            inputSchema: {
              type: "object",
              properties: {
                reason: { type: "string", minLength: 1, maxLength: 500 },
              },
              required: ["reason"],
              additionalProperties: false,
            },
            sideEffect: "process_control",
          }),
        ],
        { allowSideEffectDefinitions: true },
      );
      const restartService = vi.fn(() => ({ scheduled: true }));
      const executor = new ToolExecutor(registry, {
        clock: stores.clock,
        approvals,
        restartService,
      });
      const call = {
        id: "call-6",
        name: "mottbot_restart_service",
        arguments: { reason: "operator requested" },
      };

      const denied = await executor.execute(call, {
        sessionKey: "tg:dm:chat-1:user:user-1",
        runId: run.runId,
      });
      expect(denied.isError).toBe(true);
      expect(denied.errorCode).toBe("approval_required");
      expect(denied.contentText).toContain("Approval preview:");
      expect(denied.contentText).toContain("operator requested");
      expect(restartService).not.toHaveBeenCalled();

      const requestFingerprint = createToolRequestFingerprint({
        toolName: "mottbot_restart_service",
        arguments: { reason: "operator requested" },
      });
      approvals.approve({
        sessionKey: "tg:dm:chat-1:user:user-1",
        toolName: "mottbot_restart_service",
        approvedByUserId: "admin-1",
        reason: "approved",
        ttlMs: 60_000,
        requestFingerprint: "different-request",
      });
      const mismatched = await executor.execute(call, {
        sessionKey: "tg:dm:chat-1:user:user-1",
        runId: run.runId,
      });
      expect(mismatched.isError).toBe(true);
      expect(mismatched.errorCode).toBe("approval_mismatch");
      expect(restartService).not.toHaveBeenCalled();
      approvals.revokeActive({
        sessionKey: "tg:dm:chat-1:user:user-1",
        toolName: "mottbot_restart_service",
      });
      approvals.approve({
        sessionKey: "tg:dm:chat-1:user:user-1",
        toolName: "mottbot_restart_service",
        approvedByUserId: "admin-1",
        reason: "approved",
        ttlMs: 60_000,
        requestFingerprint,
      });
      const approved = await executor.execute(call, {
        sessionKey: "tg:dm:chat-1:user:user-1",
        runId: run.runId,
      });
      expect(approved.isError).toBe(false);
      expect(restartService).toHaveBeenCalledWith({
        reason: "operator requested",
        delayMs: 60_000,
      });
      expect(approvals.listActive("tg:dm:chat-1:user:user-1")).toEqual([]);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("executes the approved Telegram reaction tool for admins", async () => {
    const stores = createStores();
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:admin-1",
        chatId: "chat-1",
        userId: "admin-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const run = stores.runs.create({
        sessionKey: session.sessionKey,
        modelRef: session.modelRef,
        profileId: session.profileId,
      });
      const approvals = new ToolApprovalStore(stores.database, stores.clock);
      approvals.approve({
        sessionKey: session.sessionKey,
        toolName: "mottbot_telegram_react",
        approvedByUserId: "admin-1",
        reason: "operator approved reaction",
        ttlMs: 60_000,
      });
      const reactions = {
        setEmojiReaction: vi.fn(async () => true),
      };
      const executor = new ToolExecutor(createRuntimeToolRegistry({ enableSideEffectTools: true }), {
        clock: stores.clock,
        approvals,
        adminUserIds: ["admin-1"],
        handlers: createTelegramReactionToolHandlers(reactions as any),
      });

      const result = await executor.execute(
        {
          id: "call-react",
          name: "mottbot_telegram_react",
          arguments: {
            chatId: "chat-1",
            messageId: 42,
            emoji: "\u{1F44D}",
          },
        },
        {
          sessionKey: session.sessionKey,
          runId: run.runId,
          requestedByUserId: "admin-1",
        },
      );

      expect(result.isError).toBe(false);
      expect(reactions.setEmojiReaction).toHaveBeenCalledWith({
        chatId: "chat-1",
        messageId: 42,
        emoji: "\u{1F44D}",
        isBig: false,
      });
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });
});
