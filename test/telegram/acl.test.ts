import { describe, expect, it } from "vitest";
import { AccessController } from "../../src/telegram/acl.js";
import { createInboundEvent, createStores, createTestConfig } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("AccessController", () => {
  it("allows private chats", () => {
    const stores = createStores();
    try {
      const acl = new AccessController(createTestConfig(), stores.sessions, stores.messageStore);
      expect(acl.evaluate(createInboundEvent())).toEqual({ allow: true, reason: "private" });
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("requires mentions in groups by default", () => {
    const stores = createStores();
    try {
      const acl = new AccessController(createTestConfig(), stores.sessions, stores.messageStore);
      expect(
        acl.evaluate(createInboundEvent({ chatType: "group", chatId: "g1", mentionsBot: false })),
      ).toEqual({ allow: false, reason: "mention_required" });
      expect(
        acl.evaluate(createInboundEvent({ chatType: "group", chatId: "g1", mentionsBot: true })),
      ).toEqual({ allow: true, reason: "mentioned" });
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("allows replies and bound sessions in groups", () => {
    const stores = createStores();
    try {
      const acl = new AccessController(createTestConfig(), stores.sessions, stores.messageStore);
      expect(
        acl.evaluate(createInboundEvent({ chatType: "group", chatId: "g1", replyToMessageId: 10 })),
      ).toEqual({ allow: false, reason: "mention_required" });

      stores.messageStore.record({
        chatId: "g1",
        telegramMessageId: 10,
        kind: "primary",
      });
      expect(
        acl.evaluate(createInboundEvent({ chatType: "group", chatId: "g1", replyToMessageId: 10 })),
      ).toEqual({ allow: true, reason: "reply" });

      stores.sessions.ensure({
        sessionKey: "tg:bound:ops",
        chatId: "g2",
        routeMode: "bound",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      expect(acl.evaluate(createInboundEvent({ chatType: "group", chatId: "g2" }))).toEqual({
        allow: true,
        reason: "bound",
      });
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });
});
