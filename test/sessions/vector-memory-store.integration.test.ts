import { afterEach, describe, expect, it } from "vitest";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("VectorMemoryStore", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("indexes transcript messages and recalls relevant long-term memory", () => {
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

    const first = stores.transcripts.add({
      sessionKey: "s1",
      role: "assistant",
      contentText: "Your preferred deployment region is us-west-2.",
    });
    stores.clock.advance(1);
    const second = stores.transcripts.add({
      sessionKey: "s1",
      role: "assistant",
      contentText: "You use dark mode in the dashboard.",
    });

    const recalled = stores.memory.search({
      sessionKey: "s1",
      query: "Which deployment region do I use?",
      excludeMessageIds: [second.id],
    });
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.messageId).toBe(first.id);
    expect(recalled[0]?.contentText).toContain("us-west-2");
  });
});
