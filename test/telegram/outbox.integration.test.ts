import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_STATUS_TEXT, formatToolRunningStatus } from "../../src/shared/run-status.js";
import { TelegramOutbox } from "../../src/telegram/outbox.js";
import { type FakeClock, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("TelegramOutbox", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("starts, updates, and finalizes an outbox message", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.sessions.ensure({
      sessionKey: "s1",
      chatId: "chat-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: "s1",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    const clock = stores.clock as FakeClock;
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 100 })),
      editMessageText: vi.fn(async () => undefined),
    };
    const outbox = new TelegramOutbox(api as any, stores.database, clock, stores.logger, 0, stores.messageStore);

    let handle = await outbox.start({
      runId: run.runId,
      chatId: "chat-1",
      placeholderText: RUN_STATUS_TEXT.starting,
    });
    clock.advance(1);
    handle = await outbox.update(handle, "Hello world");
    const delivery = await outbox.finish(handle, "Hello world");

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).toHaveBeenCalled();
    expect(delivery.primaryMessageId).toBe(100);
    const row = stores.database.db
      .prepare("select state, last_rendered_text from outbox_messages where id = ?")
      .get(handle.outboxId) as { state: string; last_rendered_text: string };
    expect(row).toEqual({ state: "final", last_rendered_text: "Hello world" });
  });

  it("falls back to sendMessage when edits fail during failure handling", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.sessions.ensure({
      sessionKey: "s1",
      chatId: "chat-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: "s1",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 100 })),
      editMessageText: vi.fn(async () => {
        throw new Error("edit failed");
      }),
    };
    const outbox = new TelegramOutbox(
      api as any,
      stores.database,
      stores.clock as FakeClock,
      stores.logger,
      0,
      stores.messageStore,
    );
    const handle = await outbox.start({
      runId: run.runId,
      chatId: "chat-1",
      placeholderText: RUN_STATUS_TEXT.starting,
    });
    const delivery = await outbox.fail(handle, "Boom");
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(delivery.primaryMessageId).toBe(100);
  });

  it("splits long final responses into continuation messages", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.sessions.ensure({
      sessionKey: "s1",
      chatId: "chat-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: "s1",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    let nextMessageId = 100;
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
      editMessageText: vi.fn(async () => undefined),
    };
    const outbox = new TelegramOutbox(
      api as any,
      stores.database,
      stores.clock as FakeClock,
      stores.logger,
      0,
      stores.messageStore,
    );
    const handle = await outbox.start({
      runId: run.runId,
      chatId: "chat-1",
      placeholderText: RUN_STATUS_TEXT.starting,
    });

    const longText = `${"A".repeat(3900)} ${"B".repeat(300)}`;
    const delivery = await outbox.finish(handle, longText);

    expect(delivery.primaryMessageId).toBe(100);
    expect(delivery.continuationMessageIds).toEqual([101]);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(
      stores.messageStore.hasMessage({
        chatId: "chat-1",
        telegramMessageId: 101,
      }),
    ).toBe(true);
  });

  it("recovers interrupted runs and marks active outbox rows failed", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.sessions.ensure({
      sessionKey: "s1",
      chatId: "chat-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: "s1",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    const clock = stores.clock as FakeClock;
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 100 })),
      editMessageText: vi.fn(async () => undefined),
    };
    const outbox = new TelegramOutbox(api as any, stores.database, clock, stores.logger, 0, stores.messageStore);
    let handle = await outbox.start({
      runId: run.runId,
      chatId: "chat-1",
      placeholderText: RUN_STATUS_TEXT.starting,
    });
    clock.advance(1);
    handle = await outbox.update(handle, "Partial output");

    const recovered = outbox.recoverInterruptedRuns({
      runs: [{ runId: run.runId, sessionKey: "s1" }],
    });

    expect(recovered).toEqual([
      {
        runId: run.runId,
        sessionKey: "s1",
        partialText: "Partial output",
      },
    ]);
    const row = stores.database.db.prepare("select state from outbox_messages where id = ?").get(handle.outboxId) as {
      state: string;
    };
    expect(row.state).toBe("failed");
  });

  it("does not recover transient status text as partial assistant output", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.sessions.ensure({
      sessionKey: "s1",
      chatId: "chat-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: "s1",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    const clock = stores.clock as FakeClock;
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: 100 })),
      editMessageText: vi.fn(async () => undefined),
    };
    const outbox = new TelegramOutbox(api as any, stores.database, clock, stores.logger, 0, stores.messageStore);
    const handle = await outbox.start({
      runId: run.runId,
      chatId: "chat-1",
      placeholderText: RUN_STATUS_TEXT.starting,
    });
    clock.advance(1);
    await outbox.update(handle, formatToolRunningStatus("mottbot_health_snapshot"));

    const recovered = outbox.recoverInterruptedRuns({
      runs: [{ runId: run.runId, sessionKey: "s1" }],
    });

    expect(recovered).toEqual([
      {
        runId: run.runId,
        sessionKey: "s1",
      },
    ]);
  });

  it("rebinds to a continuation message when mid-stream edits fail", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.sessions.ensure({
      sessionKey: "s1",
      chatId: "chat-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: "s1",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    let nextMessageId = 100;
    const api = {
      sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
      editMessageText: vi.fn(async () => {
        throw new Error("edit failed");
      }),
    };
    const clock = stores.clock as FakeClock;
    const outbox = new TelegramOutbox(api as any, stores.database, clock, stores.logger, 0, stores.messageStore);
    let handle = await outbox.start({
      runId: run.runId,
      chatId: "chat-1",
      placeholderText: RUN_STATUS_TEXT.starting,
    });
    clock.advance(1);
    handle = await outbox.update(handle, "Streaming update");

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(handle.messageId).toBe(101);
    expect(stores.messageStore.hasMessage({ chatId: "chat-1", telegramMessageId: 101 })).toBe(true);
    const row = stores.database.db
      .prepare("select telegram_message_id, state, last_rendered_text from outbox_messages where id = ?")
      .get(handle.outboxId) as { telegram_message_id: number; state: string; last_rendered_text: string };
    expect(row).toEqual({
      telegram_message_id: 101,
      state: "active",
      last_rendered_text: "Streaming update",
    });
  });
});
