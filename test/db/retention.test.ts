import { afterEach, describe, expect, it } from "vitest";
import { buildOperationalRetentionCutoffs, pruneOperationalData } from "../../src/db/retention.js";
import { MemoryStore } from "../../src/sessions/memory-store.js";
import { AccessController } from "../../src/telegram/acl.js";
import { type FakeClock, createInboundEvent, createStores } from "../helpers/fakes.js";
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
    stores.sessions.ensure({
      sessionKey: "memory-session",
      chatId: "memory-chat",
      routeMode: "dm",
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
    stores.attachmentRecords.addMany({
      sessionKey: "terminal-session",
      runId: terminalRun.runId,
      telegramMessageId: 101,
      attachments: [
        {
          recordId: "old-file",
          kind: "document",
          fileId: "file-1",
          fileName: "old.txt",
          ingestionStatus: "extracted_text",
          extraction: { kind: "text", status: "extracted", promptChars: 10 },
        },
      ],
    });
    stores.database.db
      .prepare("update messages set created_at = ? where run_id = ?")
      .run(oldTimestamp, terminalRun.runId);
    stores.database.db
      .prepare("update attachment_records set created_at = ?, updated_at = ? where run_id = ?")
      .run(oldTimestamp, oldTimestamp, terminalRun.runId);
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
      .run(
        "outbox-terminal",
        terminalRun.runId,
        "terminal-chat",
        201,
        "old answer",
        oldTimestamp,
        oldTimestamp,
        oldTimestamp,
      );
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
    stores.attachmentRecords.addMany({
      sessionKey: "active-session",
      runId: activeRun.runId,
      telegramMessageId: 102,
      attachments: [
        {
          recordId: "active-file",
          kind: "document",
          fileId: "file-2",
          fileName: "active.txt",
          ingestionStatus: "extracted_text",
          extraction: { kind: "text", status: "extracted", promptChars: 10 },
        },
      ],
    });
    stores.database.db
      .prepare("update messages set created_at = ? where run_id = ?")
      .run(oldTimestamp, activeRun.runId);
    stores.database.db
      .prepare("update attachment_records set created_at = ?, updated_at = ? where run_id = ?")
      .run(oldTimestamp, oldTimestamp, activeRun.runId);
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
      .run(
        "outbox-active",
        activeRun.runId,
        "active-chat",
        301,
        "active answer",
        oldTimestamp,
        oldTimestamp,
        oldTimestamp,
      );

    const memories = new MemoryStore(stores.database, stores.clock);
    const archivedMemory = memories.add({
      sessionKey: "memory-session",
      contentText: "Archived memory",
    });
    stores.database.db
      .prepare("update session_memories set archived_at = ?, updated_at = ? where id = ?")
      .run(oldTimestamp, oldTimestamp, archivedMemory.id);
    const rejectedCandidate = memories.addCandidate({
      sessionKey: "memory-session",
      scope: "session",
      scopeKey: "memory-session",
      contentText: "Rejected candidate",
      sensitivity: "low",
    });
    if (!rejectedCandidate.inserted) {
      throw new Error("expected rejected candidate");
    }
    memories.rejectCandidate("memory-session", rejectedCandidate.candidate.id, "user-1");
    stores.database.db
      .prepare("update memory_candidates set updated_at = ? where id = ?")
      .run(oldTimestamp, rejectedCandidate.candidate.id);
    const pendingCandidate = memories.addCandidate({
      sessionKey: "memory-session",
      scope: "session",
      scopeKey: "memory-session",
      contentText: "Pending candidate",
      sensitivity: "low",
    });
    if (!pendingCandidate.inserted) {
      throw new Error("expected pending candidate");
    }
    stores.database.db
      .prepare("update memory_candidates set updated_at = ? where id = ?")
      .run(oldTimestamp, pendingCandidate.candidate.id);

    const dryRun = pruneOperationalData({ database: stores.database, cutoffs, dryRun: true });
    expect(dryRun).toMatchObject({
      dryRun: true,
      telegramUpdates: 1,
      messages: 1,
      attachmentRecords: 1,
      telegramBotMessages: 1,
      outboxMessages: 1,
      runs: 1,
      archivedSessionMemories: 1,
      memoryCandidates: 1,
    });
    expect(stores.runs.get(terminalRun.runId)).toBeDefined();

    const result = pruneOperationalData({ database: stores.database, cutoffs, dryRun: false });
    expect(result).toMatchObject({
      dryRun: false,
      telegramUpdates: 1,
      messages: 1,
      attachmentRecords: 1,
      telegramBotMessages: 1,
      outboxMessages: 1,
      runs: 1,
      archivedSessionMemories: 1,
      memoryCandidates: 1,
    });
    expect(stores.runs.get(terminalRun.runId)).toBeUndefined();
    expect(stores.runs.get(activeRun.runId)).toMatchObject({ status: "streaming" });
    expect(stores.attachmentRecords.listRecent("terminal-session")).toEqual([]);
    expect(stores.attachmentRecords.listRecent("active-session")).toHaveLength(1);
    expect(stores.sessions.findByChat("active-chat")).toBeDefined();
    expect(memories.list("memory-session")).toEqual([]);
    expect(
      stores.database.db
        .prepare<unknown[], { count: number }>("select count(*) as count from session_memories where id = ?")
        .get(archivedMemory.id)?.count,
    ).toBe(0);
    expect(memories.listCandidates("memory-session", "rejected")).toEqual([]);
    expect(memories.listCandidates("memory-session", "pending")).toHaveLength(1);
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
