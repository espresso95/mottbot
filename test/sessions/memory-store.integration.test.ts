import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/sessions/memory-store.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("MemoryStore", () => {
  it("adds, lists, removes, and clears session memories", () => {
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
      const memories = new MemoryStore(stores.database, stores.clock);
      const first = memories.add({
        sessionKey: "tg:dm:chat-1:user:user-1",
        contentText: "  prefers concise answers  ",
      });
      const second = memories.add({
        sessionKey: "tg:dm:chat-1:user:user-1",
        contentText: "uses pnpm",
      });

      expect(first.contentText).toBe("prefers concise answers");
      expect(first.source).toBe("explicit");
      expect(memories.list("tg:dm:chat-1:user:user-1").map((memory) => memory.id)).toEqual([
        first.id,
        second.id,
      ]);
      expect(memories.remove("tg:dm:chat-1:user:user-1", first.id.slice(0, 8))).toBe(true);
      expect(memories.list("tg:dm:chat-1:user:user-1").map((memory) => memory.id)).toEqual([second.id]);
      expect(memories.clear("tg:dm:chat-1:user:user-1")).toBe(1);
      expect(memories.list("tg:dm:chat-1:user:user-1")).toEqual([]);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("upserts a single automatic summary per session", () => {
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
      const memories = new MemoryStore(stores.database, stores.clock);

      const first = memories.upsertAutoSummary({
        sessionKey: "tg:dm:chat-1:user:user-1",
        contentText: "summary one",
      });
      stores.clock.advance(1_000);
      const second = memories.upsertAutoSummary({
        sessionKey: "tg:dm:chat-1:user:user-1",
        contentText: "summary two",
      });

      expect(second.id).toBe(first.id);
      expect(second.source).toBe("auto_summary");
      expect(memories.list("tg:dm:chat-1:user:user-1", 20, "auto_summary")).toHaveLength(1);
      expect(memories.list("tg:dm:chat-1:user:user-1")[0]?.contentText).toBe("summary two");
      expect(memories.clear("tg:dm:chat-1:user:user-1", "auto_summary")).toBe(1);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("isolates scoped memories and orders pinned memory before summaries", () => {
    const stores = createStores();
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      stores.sessions.ensure({
        sessionKey: "tg:dm:chat-2:user:user-1",
        chatId: "chat-2",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const memories = new MemoryStore(stores.database, stores.clock);
      memories.add({
        sessionKey: session.sessionKey,
        scope: "session",
        scopeKey: session.sessionKey,
        contentText: "Session-only fact",
      });
      stores.clock.advance(1);
      const personal = memories.add({
        sessionKey: session.sessionKey,
        scope: "personal",
        scopeKey: "user-1",
        contentText: "Personal fact",
        pinned: true,
      });
      stores.clock.advance(1);
      memories.upsertAutoSummary({
        sessionKey: session.sessionKey,
        contentText: "Automatic summary",
      });
      memories.add({
        sessionKey: "tg:dm:chat-2:user:user-1",
        scope: "chat",
        scopeKey: "chat-2",
        contentText: "Other chat fact",
      });

      const visible = memories.listForScopeContext(session);

      expect(visible.map((memory) => memory.contentText)).toEqual([
        "Personal fact",
        "Session-only fact",
        "Automatic summary",
      ]);
      expect(visible[0]?.id).toBe(personal.id);
      expect(visible).not.toEqual(expect.arrayContaining([expect.objectContaining({ contentText: "Other chat fact" })]));
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("stores, deduplicates, accepts, rejects, archives, and clears memory candidates", () => {
    const stores = createStores();
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const memories = new MemoryStore(stores.database, stores.clock);
      const first = memories.addCandidate({
        sessionKey: session.sessionKey,
        scope: "personal",
        scopeKey: "user-1",
        contentText: "User prefers terse replies.",
        reason: "Preference stated directly.",
        sourceMessageIds: ["msg-1"],
        sensitivity: "low",
      });
      const duplicate = memories.addCandidate({
        sessionKey: session.sessionKey,
        scope: "personal",
        scopeKey: "user-1",
        contentText: " user prefers terse replies. ",
        sensitivity: "low",
      });

      expect(first.inserted).toBe(true);
      expect(duplicate).toMatchObject({ inserted: false, reason: "duplicate_candidate" });
      if (!first.inserted) {
        throw new Error("expected inserted candidate");
      }

      const updated = memories.updateCandidate(session.sessionKey, first.candidate.id.slice(0, 8), "User prefers concise replies.");
      expect(updated?.contentText).toBe("User prefers concise replies.");
      const accepted = memories.acceptCandidate({
        sessionKey: session.sessionKey,
        idPrefix: first.candidate.id.slice(0, 8),
        decidedByUserId: "user-1",
        pinned: true,
      });
      expect(accepted?.memory.source).toBe("model_candidate");
      expect(accepted?.memory.pinned).toBe(true);
      expect(memories.listCandidates(session.sessionKey, "accepted")).toHaveLength(1);
      expect(
        memories.addCandidate({
          sessionKey: session.sessionKey,
          scope: "personal",
          scopeKey: "user-1",
          contentText: "User prefers concise replies.",
          sensitivity: "low",
        }),
      ).toMatchObject({ inserted: false, reason: "duplicate_memory" });

      const rejectable = memories.addCandidate({
        sessionKey: session.sessionKey,
        scope: "session",
        scopeKey: session.sessionKey,
        contentText: "Temporary candidate",
        sensitivity: "low",
      });
      expect(rejectable.inserted).toBe(true);
      if (rejectable.inserted) {
        expect(memories.rejectCandidate(session.sessionKey, rejectable.candidate.id.slice(0, 8), "user-1")).toBe(true);
      }
      const archived = memories.addCandidate({
        sessionKey: session.sessionKey,
        scope: "session",
        scopeKey: session.sessionKey,
        contentText: "Archive candidate",
        sensitivity: "low",
      });
      expect(archived.inserted).toBe(true);
      if (archived.inserted) {
        expect(memories.archiveCandidate(session.sessionKey, archived.candidate.id.slice(0, 8), "user-1")).toBe(true);
      }
      memories.addCandidate({
        sessionKey: session.sessionKey,
        scope: "session",
        scopeKey: session.sessionKey,
        contentText: "Clear candidate",
        sensitivity: "low",
      });
      expect(memories.clearCandidates(session.sessionKey)).toBe(1);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });
});
