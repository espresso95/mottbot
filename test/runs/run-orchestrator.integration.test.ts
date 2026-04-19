import { afterEach, describe, expect, it, vi } from "vitest";
import { RunOrchestrator } from "../../src/runs/run-orchestrator.js";
import { RunQueueStore } from "../../src/runs/run-queue-store.js";
import { SessionQueue } from "../../src/sessions/queue.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { createRuntimeToolRegistry, ToolRegistry } from "../../src/tools/registry.js";
import { RUN_STATUS_TEXT, formatToolRunningStatus } from "../../src/shared/run-status.js";
import { createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";
import { MemoryStore } from "../../src/sessions/memory-store.js";

describe("RunOrchestrator", () => {
  const cleanup: Array<() => void> = [];
  const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("persists successful runs and assistant output", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const outbox = {
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: RUN_STATUS_TEXT.starting, lastEditAt: 1 })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport = {
      stream: vi.fn(async ({ onStart, onTextDelta }) => {
        await onStart?.();
        await onTextDelta?.("hello ");
        await onTextDelta?.("world");
        return { text: "hello world", transport: "sse", requestIdentity: "req-1", usage: { input: 1, output: 2 } };
      }),
    };
    const orchestrator = new RunOrchestrator(
      stores.config,
      new SessionQueue(),
      stores.sessions,
      stores.transcripts,
      stores.runs,
      { resolve: vi.fn(async () => ({ profile: { profileId: "openai-codex:default" }, accessToken: "access", apiKey: "api" })) } as any,
      transport as any,
      outbox as any,
      stores.clock,
      stores.logger,
    );

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Build it" }),
      session,
    });

    await flushAsync();

    const messages = stores.transcripts.listRecent(session.sessionKey);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.contentText).toBe("hello world");
    expect(messages[1]?.telegramMessageId).toBe(1);
    const runRow = stores.database.db
      .prepare("select status, transport, request_identity, usage_json, started_at, finished_at from runs limit 1")
      .get() as {
        status: string;
        transport: string;
        request_identity: string;
        usage_json: string;
        started_at: number;
        finished_at: number;
      };
    expect(runRow.status).toBe("completed");
    expect(runRow.transport).toBe("sse");
    expect(runRow.request_identity).toBe("req-1");
    expect(runRow.usage_json).toContain("\"input\":1");
    expect(runRow.started_at).toBe(stores.clock.now());
    expect(runRow.finished_at).toBe(stores.clock.now());
    expect(outbox.finish).toHaveBeenCalled();
  });

  it("removes the Telegram ack reaction after a successful reply when configured", async () => {
    const stores = createStores({
      telegram: {
        reactions: {
          enabled: true,
          ackEmoji: "\u{1F440}",
          removeAckAfterReply: true,
          notifications: "own",
        },
      } as any,
    });
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const outbox = {
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: RUN_STATUS_TEXT.starting, lastEditAt: 1 })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const reactions = {
      clearReaction: vi.fn(async () => true),
    };
    const orchestrator = new RunOrchestrator(
      stores.config,
      new SessionQueue(),
      stores.sessions,
      stores.transcripts,
      stores.runs,
      { resolve: vi.fn(async () => ({ profile: { profileId: "openai-codex:default" }, accessToken: "access", apiKey: "api" })) } as any,
      {
        stream: vi.fn(async () => ({ text: "done", transport: "sse", requestIdentity: "req-ack" })),
      } as any,
      outbox as any,
      stores.clock,
      stores.logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reactions as any,
    );

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Build it", chatId: "chat-1", messageId: 42 }),
      session,
    });
    await flushAsync();

    expect(reactions.clearReaction).toHaveBeenCalledWith({
      chatId: "chat-1",
      messageId: 42,
    });
  });

  it("marks failed runs and sends failure output", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const outbox = {
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: RUN_STATUS_TEXT.starting, lastEditAt: 1 })),
      update: vi.fn(async (handle) => handle),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const orchestrator = new RunOrchestrator(
      stores.config,
      new SessionQueue(),
      stores.sessions,
      stores.transcripts,
      stores.runs,
      { resolve: vi.fn(async () => ({ profile: { profileId: "openai-codex:default" }, accessToken: "access", apiKey: "api" })) } as any,
      { stream: vi.fn(async () => { throw new Error("boom"); }) } as any,
      outbox as any,
      stores.clock,
      stores.logger,
    );

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Fail it" }),
      session,
    });

    await flushAsync();

    const runRow = stores.database.db
      .prepare("select status, error_code, error_message from runs limit 1")
      .get() as { status: string; error_code: string; error_message: string };
    expect(runRow.status).toBe("failed");
    expect(runRow.error_code).toBe("run_failed");
    expect(runRow.error_message).toContain("boom");
    expect(outbox.fail).toHaveBeenCalled();
  });

  it("updates automatic session memory summaries when enabled", async () => {
    const stores = createStores({
      memory: {
        autoSummariesEnabled: true,
        autoSummaryRecentMessages: 8,
        autoSummaryMaxChars: 500,
      },
    });
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const memories = new MemoryStore(stores.database, stores.clock);
    const outbox = {
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: RUN_STATUS_TEXT.starting, lastEditAt: 1 })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const orchestrator = new RunOrchestrator(
      stores.config,
      new SessionQueue(),
      stores.sessions,
      stores.transcripts,
      stores.runs,
      { resolve: vi.fn(async () => ({ profile: { profileId: "openai-codex:default" }, accessToken: "access", apiKey: "api" })) } as any,
      {
        stream: vi.fn(async ({ onStart }) => {
          await onStart?.();
          return { text: "Use pnpm for scripts.", transport: "sse", requestIdentity: "req-memory" };
        }),
      } as any,
      outbox as any,
      stores.clock,
      stores.logger,
      undefined,
      undefined,
      undefined,
      undefined,
      memories,
    );

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "How should I run checks?" }),
      session,
    });
    await flushAsync();

    const summary = memories.list(session.sessionKey, 20, "auto_summary")[0];
    expect(summary?.contentText).toContain("Automatic recent conversation summary");
    expect(summary?.contentText).toContain("How should I run checks?");
    expect(summary?.contentText).toContain("Use pnpm");
  });

  it("persists attachment metadata for user turns", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const outbox = {
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: RUN_STATUS_TEXT.starting, lastEditAt: 1 })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const attachmentIngestor = {
      prepare: vi.fn(async () => ({
        transcriptAttachments: [
          {
            kind: "photo",
            fileId: "photo-1",
            mimeType: "image/png",
            ingestionStatus: "native_input",
          },
        ],
        nativeInputs: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        cachePaths: ["/tmp/not-leaked.png"],
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const transport = {
      stream: vi.fn(async ({ messages, onStart }) => {
        await onStart?.();
        expect(JSON.stringify(messages)).not.toContain("/tmp/not-leaked.png");
        return { text: "noted", transport: "sse", requestIdentity: "req-2" };
      }),
    };
    const orchestrator = new RunOrchestrator(
      stores.config,
      new SessionQueue(),
      stores.sessions,
      stores.transcripts,
      stores.runs,
      { resolve: vi.fn(async () => ({ profile: { profileId: "openai-codex:default" }, accessToken: "access", apiKey: "api" })) } as any,
      transport as any,
      outbox as any,
      stores.clock,
      stores.logger,
      attachmentIngestor as any,
    );

    await orchestrator.enqueueMessage({
      event: createInboundEvent({
        text: "",
        caption: undefined,
        attachments: [{ kind: "photo", fileId: "photo-1" }],
      }),
      session,
    });

    await flushAsync();

    const messages = stores.transcripts.listRecent(session.sessionKey);
    expect(messages[0]?.contentJson).toContain("photo-1");
    expect(messages[0]?.contentJson).toContain("native_input");
    expect(messages[0]?.contentText).toBe("Shared attachments.");
    const streamMessages = transport.stream.mock.calls[0]?.[0].messages;
    const lastUserMessage = streamMessages?.findLast((message: any) => message.role === "user");
    expect(lastUserMessage?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }),
      ]),
    );
    expect(attachmentIngestor.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ allowNativeImages: true }),
    );
    expect(attachmentIngestor.cleanup).toHaveBeenCalledTimes(1);
  });

  it("executes approved read-only tool calls and continues the model response", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const outbox = {
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: RUN_STATUS_TEXT.starting, lastEditAt: 1 })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const assistantToolMessage = {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: "call-1",
          name: "mottbot_health_snapshot",
          arguments: {},
        },
      ],
      api: "openai-codex-responses" as const,
      provider: "openai-codex" as const,
      model: "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: stores.clock.now(),
    };
    const transport = {
      stream: vi
        .fn()
        .mockImplementationOnce(async ({ onStart, tools }) => {
          await onStart?.();
          expect(tools.map((tool: { name: string }) => tool.name)).toEqual(["mottbot_health_snapshot"]);
          return {
            text: "",
            transport: "sse",
            requestIdentity: "req-tool-1",
            toolCalls: [{ id: "call-1", name: "mottbot_health_snapshot", arguments: {} }],
            assistantMessage: assistantToolMessage,
            stopReason: "toolUse",
          };
        })
        .mockImplementationOnce(async ({ onStart, extraContextMessages }) => {
          await onStart?.();
          expect(extraContextMessages).toEqual([
            assistantToolMessage,
            expect.objectContaining({
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "mottbot_health_snapshot",
              isError: false,
            }),
          ]);
          return { text: "Health is ok.", transport: "sse", requestIdentity: "req-tool-2" };
        }),
    };
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry, {
      clock: stores.clock,
      health: stores.health,
    });
    const orchestrator = new RunOrchestrator(
      stores.config,
      new SessionQueue(),
      stores.sessions,
      stores.transcripts,
      stores.runs,
      { resolve: vi.fn(async () => ({ profile: { profileId: "openai-codex:default" }, accessToken: "access", apiKey: "api" })) } as any,
      transport as any,
      outbox as any,
      stores.clock,
      stores.logger,
      undefined,
      undefined,
      registry,
      executor,
    );

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Check health" }),
      session,
    });

    await flushAsync();

    const messages = stores.transcripts.listRecent(session.sessionKey);
    expect(messages.map((message) => message.role)).toEqual(["user", "tool", "assistant"]);
    expect(messages[1]?.contentText).toContain("Tool mottbot_health_snapshot completed.");
    expect(messages[1]?.contentJson).toContain("mottbot_health_snapshot");
    expect(messages[2]?.contentText).toBe("Health is ok.");
    expect(messages[2]?.contentJson).toContain('"tools"');
    expect(outbox.update).toHaveBeenCalledWith(
      expect.anything(),
      formatToolRunningStatus("mottbot_health_snapshot"),
    );
    expect(transport.stream).toHaveBeenCalledTimes(2);
  });

  it("executes an approved side-effecting restart tool once", async () => {
    const stores = createStores({
      tools: {
        enableSideEffectTools: true,
        approvalTtlMs: 60_000,
        restartDelayMs: 60_000,
      },
    });
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:admin-1",
      chatId: "chat-1",
      userId: "admin-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const approvals = new ToolApprovalStore(stores.database, stores.clock);
    approvals.approve({
      sessionKey: session.sessionKey,
      toolName: "mottbot_restart_service",
      approvedByUserId: "admin-1",
      reason: "planned restart",
      ttlMs: 60_000,
    });
    const outbox = {
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: RUN_STATUS_TEXT.starting, lastEditAt: 1 })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const assistantToolMessage = {
      role: "assistant" as const,
      content: [
        {
          type: "toolCall" as const,
          id: "call-restart",
          name: "mottbot_restart_service",
          arguments: { reason: "planned restart" },
        },
      ],
      api: "openai-codex-responses" as const,
      provider: "openai-codex" as const,
      model: "gpt-5.4",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse" as const,
      timestamp: stores.clock.now(),
    };
    const transport = {
      stream: vi
        .fn()
        .mockImplementationOnce(async ({ onStart, tools }) => {
          await onStart?.();
          const toolNames = tools.map((tool: { name: string }) => tool.name);
          expect(toolNames).toContain("mottbot_restart_service");
          expect(toolNames).toContain("mottbot_recent_runs");
          return {
            text: "",
            transport: "sse",
            requestIdentity: "req-restart-1",
            toolCalls: [{ id: "call-restart", name: "mottbot_restart_service", arguments: { reason: "planned restart" } }],
            assistantMessage: assistantToolMessage,
            stopReason: "toolUse",
          };
        })
        .mockImplementationOnce(async ({ onStart }) => {
          await onStart?.();
          return { text: "Restart scheduled.", transport: "sse", requestIdentity: "req-restart-2" };
        }),
    };
    const restartService = vi.fn(() => ({ scheduled: true }));
    const registry = createRuntimeToolRegistry({ enableSideEffectTools: true });
    const executor = new ToolExecutor(registry, {
      clock: stores.clock,
      approvals,
      restartService,
      adminUserIds: stores.config.telegram.adminUserIds,
    });
    const orchestrator = new RunOrchestrator(
      stores.config,
      new SessionQueue(),
      stores.sessions,
      stores.transcripts,
      stores.runs,
      { resolve: vi.fn(async () => ({ profile: { profileId: "openai-codex:default" }, accessToken: "access", apiKey: "api" })) } as any,
      transport as any,
      outbox as any,
      stores.clock,
      stores.logger,
      undefined,
      undefined,
      registry,
      executor,
    );

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ fromUserId: "admin-1", text: "Restart after this response" }),
      session,
    });
    await flushAsync();

    expect(restartService).toHaveBeenCalledWith({ reason: "planned restart", delayMs: 60_000 });
    expect(approvals.listActive(session.sessionKey)).toEqual([]);
    expect(
      stores.database.db
        .prepare("select count(*) as count from tool_approval_audit where decision_code = 'approved'")
        .get(),
    ).toEqual({ count: 1 });
    expect(stores.transcripts.listRecent(session.sessionKey).map((message) => message.role)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
  });

  it("recovers durable queued runs after restart", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    stores.transcripts.add({
      sessionKey: session.sessionKey,
      runId: run.runId,
      role: "user",
      contentText: "resume me",
      telegramMessageId: 42,
    });
    const durableQueue = new RunQueueStore(stores.database, stores.clock);
    durableQueue.create({
      runId: run.runId,
      sessionKey: session.sessionKey,
      event: createInboundEvent({ text: "resume me", messageId: 42 }),
    });
    const outbox = {
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 100, chatId: "chat-1", runId: run.runId, lastText: RUN_STATUS_TEXT.starting, lastEditAt: 1 })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 100, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 100 })),
    };
    const orchestrator = new RunOrchestrator(
      stores.config,
      new SessionQueue(),
      stores.sessions,
      stores.transcripts,
      stores.runs,
      { resolve: vi.fn(async () => ({ profile: { profileId: "openai-codex:default" }, accessToken: "access", apiKey: "api" })) } as any,
      {
        stream: vi.fn(async ({ onStart }) => {
          await onStart?.();
          return { text: "resumed", transport: "sse", requestIdentity: "req-recovered" };
        }),
      } as any,
      outbox as any,
      stores.clock,
      stores.logger,
      undefined,
      durableQueue,
    );

    expect(orchestrator.recoverQueuedRuns()).toEqual({ resumed: 1, failed: 0 });
    await flushAsync();

    expect(outbox.start).toHaveBeenCalledWith(expect.objectContaining({
      placeholderText: RUN_STATUS_TEXT.resumingAfterRestart,
    }));
    expect(stores.runs.get(run.runId)).toMatchObject({ status: "completed" });
    expect(durableQueue.get(run.runId)).toMatchObject({ state: "completed", attempts: 1 });
  });
});
