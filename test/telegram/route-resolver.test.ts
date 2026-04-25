import { describe, expect, it } from "vitest";
import { RouteResolver } from "../../src/telegram/route-resolver.js";
import { createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("RouteResolver", () => {
  it("creates a default dm route", () => {
    const stores = createStores();
    try {
      const resolver = new RouteResolver(stores.config, stores.sessions);
      const session = resolver.resolve(createInboundEvent());
      expect(session.sessionKey).toBe("tg:dm:chat-1:user:user-1");
      expect(session.agentId).toBe(stores.config.agents.defaultId);
      expect(session.modelRef).toBe(stores.config.models.default);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("reuses an existing bound route", () => {
    const stores = createStores();
    try {
      const existing = stores.sessions.ensure({
        sessionKey: "tg:bound:ops",
        chatId: "chat-1",
        routeMode: "bound",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const resolver = new RouteResolver(stores.config, stores.sessions);
      expect(resolver.resolve(createInboundEvent({ chatId: "chat-1", chatType: "group" }))).toEqual(existing);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("uses a configured agent binding for new routes", () => {
    const stores = createStores({
      agents: {
        defaultId: "main",
        list: [
          {
            id: "main",
            profileId: "openai-codex:default",
            modelRef: "openai-codex/gpt-5.4",
            fastMode: false,
          },
          {
            id: "docs",
            displayName: "Docs",
            profileId: "openai-codex:docs",
            modelRef: "openai-codex/gpt-5.4-mini",
            fastMode: true,
            systemPrompt: "Focus on concise documentation edits.",
          },
        ],
        bindings: [{ agentId: "docs", chatId: "chat-1", threadId: 9, projectKey: "mottbot" }],
      },
    });
    try {
      const resolver = new RouteResolver(stores.config, stores.sessions);
      const session = resolver.resolve(
        createInboundEvent({
          chatType: "supergroup",
          threadId: 9,
        }),
      );
      expect(session.sessionKey).toBe("tg:group:chat-1:topic:9");
      expect(session.agentId).toBe("docs");
      expect(session.profileId).toBe("openai-codex:docs");
      expect(session.modelRef).toBe("openai-codex/gpt-5.4-mini");
      expect(session.fastMode).toBe(true);
      expect(session.systemPrompt).toBe("Focus on concise documentation edits.");
      expect(session.projectKey).toBe("mottbot");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("attaches project memory keys to existing bound routes", () => {
    const stores = createStores({
      agents: {
        defaultId: "main",
        list: [
          {
            id: "main",
            profileId: "openai-codex:default",
            modelRef: "openai-codex/gpt-5.4",
            fastMode: false,
          },
        ],
        bindings: [{ agentId: "main", chatId: "chat-1", projectKey: "mottbot" }],
      },
    });
    try {
      stores.sessions.ensure({
        sessionKey: "tg:bound:ops",
        chatId: "chat-1",
        routeMode: "bound",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const resolver = new RouteResolver(stores.config, stores.sessions);
      const session = resolver.resolve(createInboundEvent({ chatId: "chat-1", chatType: "group" }));
      expect(session.sessionKey).toBe("tg:bound:ops");
      expect(session.projectKey).toBe("mottbot");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });
});
