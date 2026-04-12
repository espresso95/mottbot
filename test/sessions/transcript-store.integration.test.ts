import { afterEach, describe, expect, it } from "vitest";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("TranscriptStore", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("adds, lists, and clears transcript messages", () => {
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

    stores.transcripts.add({ sessionKey: "s1", role: "user", contentText: "hello" });
    stores.clock.advance(1);
    stores.transcripts.add({ sessionKey: "s1", role: "assistant", contentText: "hi" });

    expect(stores.transcripts.listRecent("s1")).toHaveLength(2);
    expect(stores.transcripts.listRecent("s1")[0]?.contentText).toBe("hello");

    stores.transcripts.clearSession("s1");
    expect(stores.transcripts.listRecent("s1")).toEqual([]);
  });
});
