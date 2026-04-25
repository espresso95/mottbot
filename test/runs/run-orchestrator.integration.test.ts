import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexResolvedAuth } from "../../src/codex/types.js";
import type { ModelTokenResolver, ModelTransport } from "../../src/models/provider.js";
import { RunOrchestrator, type RunOutbox, type RunReactionService } from "../../src/runs/run-orchestrator.js";
import { RunQueueStore } from "../../src/runs/run-queue-store.js";
import { SessionQueue } from "../../src/sessions/queue.js";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { createRuntimeToolRegistry, ToolRegistry } from "../../src/tools/registry.js";
import { createToolRequestFingerprint } from "../../src/tools/policy.js";
import { RUN_STATUS_TEXT, formatToolRunningStatus } from "../../src/shared/run-status.js";
import { createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";
import { MemoryStore } from "../../src/sessions/memory-store.js";
import type { AttachmentIngestor } from "../../src/telegram/attachments.js";
import { UsageBudgetService } from "../../src/runs/usage-budget.js";

describe("RunOrchestrator", () => {
  const cleanup: Array<() => void> = [];
  const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const createResolvedAuth = (): CodexResolvedAuth => ({
    profile: {
      profileId: "openai-codex:default",
      provider: "openai-codex",
      source: "local_oauth",
      createdAt: 1,
      updatedAt: 1,
    },
    accessToken: "access",
    apiKey: "api",
  });

  const createTokenResolver = (): ModelTokenResolver => ({
    resolve: vi.fn(async () => createResolvedAuth()),
  });

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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi.fn(async ({ onStart, onTextDelta }) => {
        await onStart?.();
        await onTextDelta?.("hello ");
        await onTextDelta?.("world");
        return { text: "hello world", transport: "sse", requestIdentity: "req-1", usage: { input: 1, output: 2 } };
      }),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
    });

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
    expect(runRow.usage_json).toContain('"input":1');
    expect(runRow.started_at).toBe(stores.clock.now());
    expect(runRow.finished_at).toBe(stores.clock.now());
    expect(outbox.start).toHaveBeenCalledWith(
      expect.objectContaining({
        replyMarkup: {
          inline_keyboard: [
            [expect.objectContaining({ text: "Stop", callback_data: expect.stringMatching(/^mb:rs:/) })],
          ],
        },
      }),
    );
    expect(outbox.finish).toHaveBeenCalledWith(
      expect.anything(),
      "hello world",
      expect.objectContaining({
        replyMarkup: {
          inline_keyboard: [
            [
              expect.objectContaining({ text: "New chat", callback_data: expect.stringMatching(/^mb:rn:/) }),
              expect.objectContaining({ text: "Usage", callback_data: expect.stringMatching(/^mb:ru:/) }),
              expect.objectContaining({ text: "Files", callback_data: expect.stringMatching(/^mb:rf:/) }),
            ],
          ],
        },
      }),
    );
  });

  it("fails before model transport when usage budget is exhausted", async () => {
    const stores = createStores({
      usage: {
        dailyRunsPerSession: 1,
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
    const prior = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    stores.runs.update(prior.runId, { status: "completed", finishedAt: stores.clock.now() });
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi.fn(),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      usageBudget: new UsageBudgetService(stores.config, stores.runs, stores.clock),
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Build it" }),
      session,
    });

    await flushAsync();

    expect(transport.stream).not.toHaveBeenCalled();
    expect(outbox.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("daily session run budget is 1/1"),
      expect.objectContaining({
        replyMarkup: {
          inline_keyboard: [
            [
              expect.objectContaining({ text: "Retry", callback_data: expect.stringMatching(/^mb:rr:/) }),
              expect.objectContaining({ text: "New chat", callback_data: expect.stringMatching(/^mb:rn:/) }),
            ],
          ],
        },
      }),
    );
    const denied = stores.runs.countByStatuses(["failed"]);
    expect(denied).toBe(1);
  });

  it("marks runs failed when the initial Telegram placeholder cannot be sent", async () => {
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => {
        throw new Error("telegram unavailable");
      }),
      update: vi.fn(),
      finish: vi.fn(),
      fail: vi.fn(),
    };
    const transport: ModelTransport = {
      stream: vi.fn(),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Build it" }),
      session,
    });
    await flushAsync();

    const row = stores.database.db.prepare("select status, error_message from runs limit 1").get() as {
      status: string;
      error_message: string;
    };
    expect(row.status).toBe("failed");
    expect(row.error_message).toContain("telegram unavailable");
    expect(transport.stream).not.toHaveBeenCalled();
    expect(outbox.fail).not.toHaveBeenCalled();
  });

  it("keeps failure status durable when Telegram failure delivery also fails", async () => {
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(),
      fail: vi.fn(async () => {
        throw new Error("telegram edit failed");
      }),
    };
    const transport: ModelTransport = {
      stream: vi.fn(async () => {
        throw new Error("model failed");
      }),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Fail it" }),
      session,
    });
    await flushAsync();

    const row = stores.database.db.prepare("select status, error_message from runs limit 1").get() as {
      status: string;
      error_message: string;
    };
    expect(row.status).toBe("failed");
    expect(row.error_message).toContain("model failed");
    expect(outbox.fail).toHaveBeenCalled();
  });

  it("removes the Telegram ack reaction after a successful reply when configured", async () => {
    const stores = createStores({
      telegram: {
        botToken: "test-token",
        polling: true,
        adminUserIds: ["admin-1"],
        allowedChatIds: [],
        webhook: {
          publicUrl: "https://example.com",
          path: "/telegram/webhook",
          host: "127.0.0.1",
          port: 8080,
          secretToken: "secret",
        },
        reactions: {
          enabled: true,
          ackEmoji: "\u{1F440}",
          removeAckAfterReply: true,
          notifications: "own",
        },
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const reactions: RunReactionService = {
      clearReaction: vi.fn(async () => true),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport: {
        stream: vi.fn(async () => ({ text: "done", transport: "sse", requestIdentity: "req-ack" })),
      } satisfies ModelTransport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      reactions,
    });

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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle) => handle),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport: {
        stream: vi.fn(async () => {
          throw new Error("boom");
        }),
      } satisfies ModelTransport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Fail it" }),
      session,
    });

    await flushAsync();

    const runRow = stores.database.db.prepare("select status, error_code, error_message from runs limit 1").get() as {
      status: string;
      error_code: string;
      error_message: string;
    };
    expect(runRow.status).toBe("failed");
    expect(runRow.error_code).toBe("run_failed");
    expect(runRow.error_message).toContain("boom");
    expect(outbox.fail).toHaveBeenCalled();
  });

  it("guides attachment-backed failed runs without offering retry", async () => {
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const attachmentIngestor: AttachmentIngestor = {
      prepare: vi.fn(async () => ({
        transcriptAttachments: [
          {
            kind: "document",
            fileId: "file-1",
            fileName: "report.pdf",
            ingestionStatus: "metadata_only",
          },
        ],
        nativeInputs: [],
        extractedTexts: [],
        cachePaths: [],
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport: {
        stream: vi.fn(async () => {
          throw new Error("attachment failure");
        }),
      } satisfies ModelTransport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      attachments: attachmentIngestor,
      attachmentRecords: stores.attachmentRecords,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({
        text: "Review this file.",
        attachments: [{ kind: "document", fileId: "file-1", fileName: "report.pdf" }],
      }),
      session,
    });

    await flushAsync();

    const failure = vi.mocked(outbox.fail).mock.calls[0];
    expect(failure?.[1]).toContain("Send the file again to retry it");
    expect(failure?.[2]?.replyMarkup?.inline_keyboard[0]?.map((button) => button.text)).toEqual(["New chat", "Files"]);
  });

  it("retries a failed run from the original user message", async () => {
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi
        .fn()
        .mockRejectedValueOnce(new Error("temporary failure"))
        .mockResolvedValueOnce({ text: "retry ok", transport: "sse", requestIdentity: "req-retry" }),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ messageId: 41, text: "Build it again" }),
      session,
    });
    await flushAsync();

    const failedRun = stores.database.db
      .prepare<unknown[], { run_id: string }>("select run_id from runs where status = 'failed' limit 1")
      .get();
    expect(failedRun?.run_id).toBeTruthy();

    await expect(
      orchestrator.retryRun({
        event: createInboundEvent({ messageId: 42, text: "Retry" }),
        session,
        runId: failedRun!.run_id,
      }),
    ).resolves.toBe("queued");
    await flushAsync();

    expect(transport.stream).toHaveBeenCalledTimes(2);
    expect(outbox.finish).toHaveBeenCalledWith(expect.anything(), "retry ok", expect.any(Object));
    expect(stores.runs.countByStatuses(["completed"])).toBe(1);
    expect(stores.transcripts.listRecent(session.sessionKey).map((message) => message.contentText)).toEqual([
      "Build it again",
      "Build it again",
      "retry ok",
    ]);
  });

  it("refuses button retry for failed runs that used attachments", async () => {
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
    const transport: ModelTransport = {
      stream: vi.fn(async () => ({ text: "should not run", transport: "sse", requestIdentity: "req" })),
    };
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
    });
    const run = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    stores.runs.update(run.runId, {
      status: "failed",
      errorCode: "run_failed",
      errorMessage: "boom",
      finishedAt: stores.clock.now(),
    });
    stores.transcripts.add({
      sessionKey: session.sessionKey,
      runId: run.runId,
      role: "user",
      telegramMessageId: 41,
      contentText: "Review this file.",
      contentJson: JSON.stringify({
        attachments: [{ kind: "document", fileId: "file-1", ingestionStatus: "metadata_only" }],
      }),
    });

    await expect(
      orchestrator.retryRun({
        event: createInboundEvent({ messageId: 42, text: "Retry" }),
        session,
        runId: run.runId,
      }),
    ).resolves.toBe("attachments_not_retryable");

    expect(transport.stream).not.toHaveBeenCalled();
    expect(stores.runs.countByStatuses(["queued", "starting", "streaming", "completed"])).toBe(0);
    expect(
      stores.database.db.prepare<unknown[], { count: number }>("select count(*) as count from runs").get()?.count,
    ).toBe(1);
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport: {
        stream: vi.fn(async ({ onStart }) => {
          await onStart?.();
          return { text: "Use pnpm for scripts.", transport: "sse", requestIdentity: "req-memory" };
        }),
      } satisfies ModelTransport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      memories: memories,
    });

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

  it("stores model-proposed memory candidates after successful runs when enabled", async () => {
    const stores = createStores({
      memory: {
        candidateExtractionEnabled: true,
        candidateRecentMessages: 8,
        candidateMaxPerRun: 2,
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi
        .fn()
        .mockImplementationOnce(async ({ onStart }) => {
          await onStart?.();
          return { text: "Use pnpm for checks.", transport: "sse", requestIdentity: "req-answer" };
        })
        .mockImplementationOnce(async () => ({
          text: JSON.stringify({
            candidates: [
              {
                contentText: "User prefers pnpm for repository checks.",
                reason: "Preference appeared in the latest conversation.",
                scope: "personal",
                sensitivity: "low",
              },
            ],
          }),
          transport: "sse",
          requestIdentity: "req-memory-candidates",
        })),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      memories: memories,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Use pnpm when checking this repo." }),
      session,
    });
    await flushAsync();

    expect(transport.stream).toHaveBeenCalledTimes(2);
    expect(memories.listCandidates(session.sessionKey)).toEqual([
      expect.objectContaining({
        scope: "personal",
        scopeKey: "user-1",
        contentText: "User prefers pnpm for repository checks.",
        sensitivity: "low",
      }),
    ]);
  });

  it("does not fail completed runs when memory candidate extraction returns malformed JSON", async () => {
    const stores = createStores({
      memory: {
        candidateExtractionEnabled: true,
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi
        .fn()
        .mockImplementationOnce(async () => ({ text: "Done.", transport: "sse", requestIdentity: "req-answer" }))
        .mockImplementationOnce(async () => ({
          text: "not json",
          transport: "sse",
          requestIdentity: "req-bad-memory",
        })),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      memories: memories,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Remember that I prefer direct answers." }),
      session,
    });
    await flushAsync();

    const row = stores.database.db.prepare<unknown[], { status: string }>("select status from runs limit 1").get();
    expect(row?.status).toBe("completed");
    expect(memories.listCandidates(session.sessionKey)).toEqual([]);
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const attachmentIngestor: AttachmentIngestor = {
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
        extractedTexts: [],
        cachePaths: ["/tmp/not-leaked.png"],
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const transport: ModelTransport = {
      stream: vi.fn(async ({ messages, onStart }) => {
        await onStart?.();
        expect(JSON.stringify(messages)).not.toContain("/tmp/not-leaked.png");
        return { text: "noted", transport: "sse", requestIdentity: "req-2" };
      }),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      attachments: attachmentIngestor,
      attachmentRecords: stores.attachmentRecords,
    });

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
    expect(messages[0]?.contentJson).toContain("recordId");
    expect(messages[0]?.contentText).toBe("Shared attachments.");
    expect(stores.attachmentRecords.listRecent(session.sessionKey)).toEqual([
      expect.objectContaining({
        fileId: "photo-1",
        ingestionStatus: "native_input",
      }),
    ]);
    const streamMessages = transport.stream.mock.calls[0]?.[0].messages;
    const lastUserMessage = streamMessages?.findLast((message) => message.role === "user");
    expect(lastUserMessage?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image", data: "aW1hZ2U=", mimeType: "image/png" })]),
    );
    expect(attachmentIngestor.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ allowNativeFiles: false, allowNativeImages: true }),
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
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
    const transport: ModelTransport = {
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
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      toolRegistry: registry,
      toolExecutor: executor,
    });

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
      expect.objectContaining({
        replyMarkup: {
          inline_keyboard: [
            [expect.objectContaining({ text: "Stop", callback_data: expect.stringMatching(/^mb:rs:/) })],
          ],
        },
      }),
    );
    expect(transport.stream).toHaveBeenCalledTimes(2);
  });

  it("filters model tool declarations through run governance policy", async () => {
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi.fn(async ({ onStart, tools }) => {
        await onStart?.();
        expect(tools).toBeUndefined();
        return { text: "No tools exposed.", transport: "sse", requestIdentity: "req-no-tools" };
      }),
    };
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry, {
      clock: stores.clock,
      health: stores.health,
    });
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      toolRegistry: registry,
      toolExecutor: executor,
      governance: {
        isToolAllowed: () => false,
      },
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "Check health" }),
      session,
    });

    await flushAsync();

    expect(transport.stream).toHaveBeenCalledOnce();
    expect(stores.transcripts.listRecent(session.sessionKey).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("rejects runs when governance disallows the selected agent model", async () => {
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
      agentId: "main",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4-mini",
    });
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi.fn(async () => ({ text: "", transport: "sse", requestIdentity: "unused" })),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      governance: {
        isModelAllowed: ({ modelRef }) => modelRef === "openai-codex/gpt-5.4",
      },
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "hello" }),
      session,
    });

    await flushAsync();

    expect(transport.stream).not.toHaveBeenCalled();
    expect(outbox.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("not allowed in this chat"),
      expect.objectContaining({
        replyMarkup: {
          inline_keyboard: [
            [
              expect.objectContaining({ text: "Retry", callback_data: expect.stringMatching(/^mb:rr:/) }),
              expect.objectContaining({ text: "New chat", callback_data: expect.stringMatching(/^mb:rn:/) }),
            ],
          ],
        },
      }),
    );
  });

  it("rejects new runs when the selected agent queue is full", async () => {
    const stores = createStores({
      agents: {
        defaultId: "main",
        list: [
          {
            id: "main",
            profileId: "openai-codex:default",
            modelRef: "openai-codex/gpt-5.4",
            fastMode: false,
            maxQueuedRuns: 0,
          },
        ],
        bindings: [],
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
      agentId: "main",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi.fn(async () => ({ text: "", transport: "sse", requestIdentity: "unused" })),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ text: "hello" }),
      session,
    });

    expect(transport.stream).not.toHaveBeenCalled();
    expect(stores.runs.countByAgentStatuses("main", ["failed"])).toBe(1);
    expect(outbox.fail).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("queue is full"),
      expect.objectContaining({
        replyMarkup: {
          inline_keyboard: [
            [
              expect.objectContaining({ text: "Retry", callback_data: expect.stringMatching(/^mb:rr:/) }),
              expect.objectContaining({ text: "New chat", callback_data: expect.stringMatching(/^mb:rn:/) }),
            ],
          ],
        },
      }),
    );
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
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
    const transport: ModelTransport = {
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
            toolCalls: [
              { id: "call-restart", name: "mottbot_restart_service", arguments: { reason: "planned restart" } },
            ],
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
    const durableQueue = new RunQueueStore(stores.database, stores.clock);
    const executor = new ToolExecutor(registry, {
      clock: stores.clock,
      approvals,
      restartService,
      adminUserIds: stores.config.telegram.adminUserIds,
    });
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      runQueue: durableQueue,
      toolRegistry: registry,
      toolExecutor: executor,
    });

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

  it("adds approval buttons when side-effecting tools need approval", async () => {
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
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
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
    const transport: ModelTransport = {
      stream: vi
        .fn()
        .mockResolvedValueOnce({
          text: "",
          transport: "sse",
          requestIdentity: "req-restart-1",
          toolCalls: [
            { id: "call-restart", name: "mottbot_restart_service", arguments: { reason: "planned restart" } },
          ],
          assistantMessage: assistantToolMessage,
          stopReason: "toolUse",
        })
        .mockResolvedValueOnce({
          text: "Approval required before restarting.",
          transport: "sse",
          requestIdentity: "req-restart-2",
        }),
    };
    const restartService = vi.fn(() => ({ scheduled: true }));
    const registry = createRuntimeToolRegistry({ enableSideEffectTools: true });
    const durableQueue = new RunQueueStore(stores.database, stores.clock);
    const executor = new ToolExecutor(registry, {
      clock: stores.clock,
      approvals,
      restartService,
      adminUserIds: stores.config.telegram.adminUserIds,
    });
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      runQueue: durableQueue,
      toolRegistry: registry,
      toolExecutor: executor,
    });

    await orchestrator.enqueueMessage({
      event: createInboundEvent({ fromUserId: "admin-1", text: "Restart after this response" }),
      session,
    });
    await flushAsync();

    expect(restartService).not.toHaveBeenCalled();
    expect(outbox.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Approval required before restarting."),
      expect.objectContaining({
        replyMarkup: {
          inline_keyboard: [
            [
              expect.objectContaining({
                text: "Approve restart service",
                callback_data: expect.stringMatching(/^mb:ta:/),
              }),
              expect.objectContaining({
                text: "Deny",
                callback_data: expect.stringMatching(/^mb:td:/),
              }),
            ],
          ],
        },
      }),
    );
    expect(outbox.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Approval request\nTool: restart service"),
      expect.anything(),
    );
  });

  it("continues an approved tool callback by executing the stored tool call directly", async () => {
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
    const priorRun = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    const toolCall = {
      id: "call-restart",
      name: "mottbot_restart_service",
      arguments: { reason: "planned restart" },
    };
    const requestFingerprint = createToolRequestFingerprint({
      toolName: toolCall.name,
      arguments: toolCall.arguments,
    });
    const approvals = new ToolApprovalStore(stores.database, stores.clock);
    const pending = approvals.recordAudit({
      sessionKey: session.sessionKey,
      runId: priorRun.runId,
      toolName: toolCall.name,
      sideEffect: "process_control",
      allowed: false,
      decisionCode: "approval_required",
      requestedAt: stores.clock.now(),
      decidedAt: stores.clock.now(),
      requestFingerprint,
      previewText: "Restart service after review.",
    });
    approvals.approve({
      sessionKey: session.sessionKey,
      toolName: toolCall.name,
      approvedByUserId: "admin-1",
      reason: "callback approval",
      ttlMs: 60_000,
      requestFingerprint,
      previewText: "Restart service after review.",
    });
    stores.transcripts.add({
      sessionKey: session.sessionKey,
      runId: priorRun.runId,
      role: "user",
      contentText: "Restart after this response",
      telegramMessageId: 41,
    });
    stores.transcripts.add({
      sessionKey: session.sessionKey,
      runId: priorRun.runId,
      role: "tool",
      contentText: "Tool mottbot_restart_service failed: approval required.",
      contentJson: JSON.stringify({
        toolCall,
        result: {
          isError: true,
          elapsedMs: 0,
          outputBytes: 100,
          truncated: false,
          errorCode: "approval_required",
          approvalRequestId: pending.id,
        },
      }),
    });
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: "run",
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi.fn(async ({ onStart, extraContextMessages }) => {
        await onStart?.();
        expect(extraContextMessages).toEqual([
          expect.objectContaining({
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-restart",
                name: "mottbot_restart_service",
                arguments: { reason: "planned restart" },
              },
            ],
          }),
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "call-restart",
            toolName: "mottbot_restart_service",
            isError: false,
          }),
        ]);
        return { text: "Restart scheduled.", transport: "sse", requestIdentity: "req-continuation" };
      }),
    };
    const restartService = vi.fn(() => ({ scheduled: true }));
    const registry = createRuntimeToolRegistry({ enableSideEffectTools: true });
    const durableQueue = new RunQueueStore(stores.database, stores.clock);
    const executor = new ToolExecutor(registry, {
      clock: stores.clock,
      approvals,
      restartService,
      adminUserIds: stores.config.telegram.adminUserIds,
    });
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      runQueue: durableQueue,
      toolRegistry: registry,
      toolExecutor: executor,
    });

    const queued = await orchestrator.continueApprovedTool({
      event: createInboundEvent({ fromUserId: "admin-1", messageId: 42, text: "Approved from button." }),
      session,
      pending,
    });
    await flushAsync();

    expect(queued).toBe(true);
    expect(transport.stream).toHaveBeenCalledTimes(1);
    expect(restartService).toHaveBeenCalledWith({ reason: "planned restart", delayMs: 60_000 });
    expect(approvals.listActive(session.sessionKey)).toEqual([]);
    expect(stores.database.db.prepare("select state, attempts from run_queue").all()).toEqual([
      {
        state: "completed",
        attempts: 1,
      },
    ]);
    expect(stores.transcripts.listRecent(session.sessionKey).map((message) => message.role)).toEqual([
      "user",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(outbox.finish).toHaveBeenCalledWith(
      expect.anything(),
      "Restart scheduled.",
      expect.objectContaining({
        replyMarkup: {
          inline_keyboard: [
            [
              expect.objectContaining({ text: "New chat", callback_data: expect.stringMatching(/^mb:rn:/) }),
              expect.objectContaining({ text: "Usage", callback_data: expect.stringMatching(/^mb:ru:/) }),
              expect.objectContaining({ text: "Files", callback_data: expect.stringMatching(/^mb:rf:/) }),
            ],
          ],
        },
      }),
    );
  });

  it("recovers approved tool continuations from the durable run queue", async () => {
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
    const priorRun = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    const continuationRun = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    const toolCall = {
      id: "call-restart",
      name: "mottbot_restart_service",
      arguments: { reason: "planned restart" },
    };
    const requestFingerprint = createToolRequestFingerprint({
      toolName: toolCall.name,
      arguments: toolCall.arguments,
    });
    const approvals = new ToolApprovalStore(stores.database, stores.clock);
    const pending = approvals.recordAudit({
      sessionKey: session.sessionKey,
      runId: priorRun.runId,
      toolName: toolCall.name,
      sideEffect: "process_control",
      allowed: false,
      decisionCode: "approval_required",
      requestedAt: stores.clock.now(),
      decidedAt: stores.clock.now(),
      requestFingerprint,
      previewText: "Restart service after review.",
    });
    approvals.approve({
      sessionKey: session.sessionKey,
      toolName: toolCall.name,
      approvedByUserId: "admin-1",
      reason: "callback approval",
      ttlMs: 60_000,
      requestFingerprint,
      previewText: "Restart service after review.",
    });
    stores.transcripts.add({
      sessionKey: session.sessionKey,
      runId: priorRun.runId,
      role: "user",
      contentText: "Restart after this response",
      telegramMessageId: 41,
    });
    stores.transcripts.add({
      sessionKey: session.sessionKey,
      runId: priorRun.runId,
      role: "tool",
      contentText: "Tool mottbot_restart_service failed: approval required.",
      contentJson: JSON.stringify({
        toolCall,
        result: {
          isError: true,
          elapsedMs: 0,
          outputBytes: 100,
          truncated: false,
          errorCode: "approval_required",
          approvalRequestId: pending.id,
        },
      }),
    });
    const durableQueue = new RunQueueStore(stores.database, stores.clock);
    durableQueue.create({
      runId: continuationRun.runId,
      sessionKey: session.sessionKey,
      event: createInboundEvent({ fromUserId: "admin-1", messageId: 42, text: "Approved from button." }),
      approvedToolContinuation: {
        type: "approved_tool",
        pending,
        toolCall,
      },
    });
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 1,
        chatId: "chat-1",
        runId: continuationRun.runId,
        lastText: RUN_STATUS_TEXT.resumingAfterRestart,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 1, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 1 })),
    };
    const transport: ModelTransport = {
      stream: vi.fn(async ({ onStart, extraContextMessages }) => {
        await onStart?.();
        expect(extraContextMessages).toEqual([
          expect.objectContaining({
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-restart",
                name: "mottbot_restart_service",
                arguments: { reason: "planned restart" },
              },
            ],
          }),
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "call-restart",
            toolName: "mottbot_restart_service",
            isError: false,
          }),
        ]);
        return { text: "Restart scheduled after recovery.", transport: "sse", requestIdentity: "req-recovered-tool" };
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
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      runQueue: durableQueue,
      toolRegistry: registry,
      toolExecutor: executor,
    });

    expect(orchestrator.recoverQueuedRuns()).toEqual({ resumed: 1, failed: 0 });
    await flushAsync();

    expect(outbox.start).toHaveBeenCalledWith(
      expect.objectContaining({
        placeholderText: RUN_STATUS_TEXT.resumingAfterRestart,
      }),
    );
    expect(restartService).toHaveBeenCalledWith({ reason: "planned restart", delayMs: 60_000 });
    expect(stores.runs.get(continuationRun.runId)).toMatchObject({ status: "completed" });
    expect(durableQueue.get(continuationRun.runId)).toMatchObject({ state: "completed", attempts: 1 });
    expect(stores.transcripts.listRecent(session.sessionKey).map((message) => message.role)).toEqual([
      "user",
      "tool",
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
      event: createInboundEvent({
        text: "resume me",
        messageId: 42,
        attachments: [{ kind: "photo", fileId: "recovered-photo", fileUniqueId: "recovered-photo-unique" }],
      }),
    });
    const outbox: RunOutbox = {
      start: vi.fn(async () => ({
        outboxId: "o1",
        messageId: 100,
        chatId: "chat-1",
        runId: run.runId,
        lastText: RUN_STATUS_TEXT.starting,
        lastEditAt: 1,
      })),
      update: vi.fn(async (handle, text) => ({ ...handle, lastText: text })),
      finish: vi.fn(async () => ({ primaryMessageId: 100, continuationMessageIds: [] })),
      fail: vi.fn(async () => ({ primaryMessageId: 100 })),
    };
    const orchestrator = new RunOrchestrator({
      config: stores.config,
      queue: new SessionQueue(),
      sessions: stores.sessions,
      transcripts: stores.transcripts,
      runs: stores.runs,
      tokenResolver: createTokenResolver(),
      transport: {
        stream: vi.fn(async ({ onStart }) => {
          await onStart?.();
          return { text: "resumed", transport: "sse", requestIdentity: "req-recovered" };
        }),
      } satisfies ModelTransport,
      outbox,
      clock: stores.clock,
      logger: stores.logger,
      runQueue: durableQueue,
      attachmentRecords: stores.attachmentRecords,
    });

    expect(orchestrator.recoverQueuedRuns()).toEqual({ resumed: 1, failed: 0 });
    await flushAsync();

    expect(outbox.start).toHaveBeenCalledWith(
      expect.objectContaining({
        placeholderText: RUN_STATUS_TEXT.resumingAfterRestart,
      }),
    );
    expect(stores.runs.get(run.runId)).toMatchObject({ status: "completed" });
    expect(durableQueue.get(run.runId)).toMatchObject({ state: "completed", attempts: 1 });
    expect(stores.attachmentRecords.listRecent(session.sessionKey)).toEqual([
      expect.objectContaining({
        fileId: "recovered-photo",
        fileUniqueId: "recovered-photo-unique",
        kind: "photo",
      }),
    ]);
    expect(stores.transcripts.listRecent(session.sessionKey)[0]?.contentJson).toContain("recovered-photo");
  });
});
