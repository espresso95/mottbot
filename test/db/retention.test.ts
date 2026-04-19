import { afterEach, describe, expect, it } from "vitest";
import { buildOperationalRetentionCutoffs, pruneOperationalData } from "../../src/db/retention.js";
import { AccessController } from "../../src/telegram/acl.js";
import { FakeClock, createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("operational retention", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("prunes old terminal operational rows while preserving active runs and reply ACL", () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });

    const clock = stores.clock as FakeClock;
    const now = clock.now();
    const oldTimestamp = now - 40 * 24 * 60 * 60 * 1000;
    const cutoffs = buildOperationalRetentionCutoffs({ now, olderThanDays: 30 });

    stores.sessions.ensure({
      sessionKey: "terminal-session",
      chatId: "terminal-chat",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    stores.sessions.ensure({
      sessionKey: "active-session",
      chatId: "active-chat",
      routeMode: "group",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });

    const terminalRun = stores.runs.create({
      sessionKey: "terminal-session",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    stores.runs.update(terminalRun.runId, { status: "completed", finishedAt: oldTimestamp });
    stores.database.db
      .prepare("update runs set created_at = ?, updated_at = ?, finished_at = ? where run_id = ?")
      .run(oldTimestamp, oldTimestamp, oldTimestamp, terminalRun.runId);
    stores.transcripts.add({
      sessionKey: "terminal-session",
      runId: terminalRun.runId,
      role: "assistant",
      contentText: "old answer",
    });
    stores.database.db
      .prepare("update messages set created_at = ? where run_id = ?")
      .run(oldTimestamp, terminalRun.runId);
    stores.messageStore.record({
      runId: terminalRun.runId,
      chatId: "terminal-chat",
      telegramMessageId: 201,
      kind: "primary",
    });
    stores.database.db
      .prepare("update telegram_bot_messages set created_at = ? where run_id = ?")
      .run(oldTimestamp, terminalRun.runId);
    stores.database.db
      .prepare(
        `insert into outbox_messages (
          id, run_id, chat_id, thread_id, telegram_message_id, state, last_rendered_text, last_edit_at, created_at, updated_at
        ) values (?, ?, ?, null, ?, 'final', ?, ?, ?, ?)`,
      )
      .run("outbox-terminal", terminalRun.runId, "terminal-chat", 201, "old answer", oldTimestamp, oldTimestamp, oldTimestamp);
    stores.updateStore.markProcessed({
      updateId: 9001,
      chatId: "terminal-chat",
      messageId: 11,
    });
    stores.database.db
      .prepare("update telegram_updates set processed_at = ? where update_id = ?")
      .run(oldTimestamp, 9001);

    const activeRun = stores.runs.create({
      sessionKey: "active-session",
      modelRef: "openai-codex/gpt-5.4",
      profileId: "openai-codex:default",
    });
    stores.runs.update(activeRun.runId, { status: "streaming", startedAt: oldTimestamp });
    stores.database.db
      .prepare("update runs set created_at = ?, updated_at = ?, started_at = ? where run_id = ?")
      .run(oldTimestamp, oldTimestamp, oldTimestamp, activeRun.runId);
    stores.transcripts.add({
      sessionKey: "active-session",
      runId: activeRun.runId,
      role: "assistant",
      contentText: "active answer",
    });
    stores.database.db
      .prepare("update messages set created_at = ? where run_id = ?")
      .run(oldTimestamp, activeRun.runId);
    stores.messageStore.record({
      runId: activeRun.runId,
      chatId: "active-chat",
      telegramMessageId: 301,
      kind: "primary",
    });
    stores.database.db
      .prepare("update telegram_bot_messages set created_at = ? where run_id = ?")
      .run(oldTimestamp, activeRun.runId);
    stores.database.db
      .prepare(
        `insert into outbox_messages (
          id, run_id, chat_id, thread_id, telegram_message_id, state, last_rendered_text, last_edit_at, created_at, updated_at
        ) values (?, ?, ?, null, ?, 'active', ?, ?, ?, ?)`,
      )
      .run("outbox-active", activeRun.runId, "active-chat", 301, "active answer", oldTimestamp, oldTimestamp, oldTimestamp);

    const dryRun = pruneOperationalData({ database: stores.database, cutoffs, dryRun: true });
    expect(dryRun).toMatchObject({
      dryRun: true,
      telegramUpdates: 1,
      messages: 1,
      telegramBotMessages: 1,
      outboxMessages: 1,
      runs: 1,
    });
    expect(stores.runs.get(terminalRun.runId)).toBeDefined();

    const result = pruneOperationalData({ database: stores.database, cutoffs, dryRun: false });
    expect(result).toMatchObject({
      dryRun: false,
      telegramUpdates: 1,
      messages: 1,
      telegramBotMessages: 1,
      outboxMessages: 1,
      runs: 1,
    });
    expect(stores.runs.get(terminalRun.runId)).toBeUndefined();
    expect(stores.runs.get(activeRun.runId)).toMatchObject({ status: "streaming" });
    expect(stores.sessions.findByChat("active-chat")).toBeDefined();
    expect(stores.updateStore.countProcessed()).toBe(0);
    expect(stores.messageStore.hasMessage({ chatId: "terminal-chat", telegramMessageId: 201 })).toBe(false);
    expect(stores.messageStore.hasMessage({ chatId: "active-chat", telegramMessageId: 301 })).toBe(true);

    const access = new AccessController(stores.config, stores.sessions, stores.messageStore);
    expect(
      access.evaluate(
        createInboundEvent({
          chatId: "active-chat",
          chatType: "group",
          replyToMessageId: 301,
          mentionsBot: false,
        }),
      ),
    ).toEqual({ allow: true, reason: "reply" });
  });
});
