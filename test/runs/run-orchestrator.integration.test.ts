import { afterEach, describe, expect, it, vi } from "vitest";
import { RunOrchestrator } from "../../src/runs/run-orchestrator.js";
import { SessionQueue } from "../../src/sessions/queue.js";
import { createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

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
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: "Working...", lastEditAt: 1 })),
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
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: "Working...", lastEditAt: 1 })),
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
      start: vi.fn(async () => ({ outboxId: "o1", messageId: 1, chatId: "chat-1", runId: "run", lastText: "Working...", lastEditAt: 1 })),
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
          return { text: "noted", transport: "sse", requestIdentity: "req-2" };
        }),
      } as any,
      outbox as any,
      stores.clock,
      stores.logger,
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
    expect(messages[0]?.contentText).toBe("Shared attachments.");
  });
});
