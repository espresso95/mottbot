import { afterEach, describe, expect, it } from "vitest";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("SessionStore", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("creates and updates session settings", () => {
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
    stores.sessions.setModelRef(session.sessionKey, "openai-codex/gpt-5.4-mini");
    stores.sessions.setProfileId(session.sessionKey, "openai-codex:work");
    stores.sessions.setFastMode(session.sessionKey, true);
    stores.sessions.setSystemPrompt(session.sessionKey, "custom");

    expect(stores.sessions.get(session.sessionKey)).toMatchObject({
      modelRef: "openai-codex/gpt-5.4-mini",
      profileId: "openai-codex:work",
      fastMode: true,
      systemPrompt: "custom",
    });
    stores.sessions.setAgent(session.sessionKey, {
      id: "docs",
      profileId: "openai-codex:docs",
      modelRef: "openai-codex/gpt-5.3-codex-spark",
      fastMode: false,
    });
    expect(stores.sessions.get(session.sessionKey)).toMatchObject({
      agentId: "docs",
      modelRef: "openai-codex/gpt-5.3-codex-spark",
      profileId: "openai-codex:docs",
      fastMode: false,
    });
    expect(stores.sessions.get(session.sessionKey)?.systemPrompt).toBeUndefined();
  });

  it("binds and unbinds without breaking dm routing", () => {
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
    stores.sessions.bind(session.sessionKey, "here");
    expect(stores.sessions.get(session.sessionKey)?.routeMode).toBe("bound");
    stores.sessions.unbind(session.sessionKey);
    expect(stores.sessions.get(session.sessionKey)?.routeMode).toBe("dm");
  });
});
