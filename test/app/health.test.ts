import { afterEach, describe, expect, it } from "vitest";
import { RUN_STATUS_TEXT } from "../../src/shared/run-status.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("HealthReporter", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("reports current runtime counts", () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });

    stores.authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "local_oauth",
      accessToken: "access",
      refreshToken: "refresh",
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
    const queuedRun = stores.runs.create({
      sessionKey: "s1",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    stores.runs.update(run.runId, { status: "starting" });
    stores.database.db
      .prepare(
        `insert into outbox_messages (
          id, run_id, chat_id, thread_id, telegram_message_id, state, last_rendered_text, last_edit_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "outbox-1",
        queuedRun.runId,
        "chat-1",
        null,
        100,
        "active",
        RUN_STATUS_TEXT.starting,
        stores.clock.now() - 10 * 60 * 1000,
        stores.clock.now() - 10 * 60 * 1000,
        stores.clock.now() - 10 * 60 * 1000,
      );
    stores.updateStore.begin(5);
    stores.updateStore.markProcessed({ updateId: 5, chatId: "chat-1", messageId: 10 });

    const snapshot = stores.health.snapshot();

    expect(snapshot.sessions).toBe(1);
    expect(snapshot.authProfiles).toBe(1);
    expect(snapshot.queuedRuns).toBe(1);
    expect(snapshot.activeRuns).toBe(1);
    expect(snapshot.interruptedRuns).toBe(1);
    expect(snapshot.staleOutboxMessages).toBe(1);
    expect(snapshot.processedUpdates).toBe(1);
    expect(snapshot.status).toBe("degraded");
  });
});
