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
});
