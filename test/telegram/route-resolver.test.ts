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
});
