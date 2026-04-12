import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramOutbox } from "../../src/telegram/outbox.js";
import { FakeClock, createStores } from "../helpers/fakes.js";
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
    const outbox = new TelegramOutbox(api as any, stores.database, clock, stores.logger, 0);

    let handle = await outbox.start({
      runId: run.runId,
      chatId: "chat-1",
      placeholderText: "Working...",
    });
    clock.advance(1);
    handle = await outbox.update(handle, "Hello world");
    await outbox.finish(handle, "Hello world");

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).toHaveBeenCalled();
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
    const outbox = new TelegramOutbox(api as any, stores.database, stores.clock as FakeClock, stores.logger, 0);
    const handle = await outbox.start({
      runId: run.runId,
      chatId: "chat-1",
      placeholderText: "Working...",
    });
    await outbox.fail(handle, "Boom");
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });
});
