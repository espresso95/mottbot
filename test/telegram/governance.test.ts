import { describe, expect, it } from "vitest";
import { parseChatGovernancePolicy, TelegramGovernanceStore } from "../../src/telegram/governance.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("TelegramGovernanceStore", () => {
  it("resolves config owners and persistent user roles", () => {
    const stores = createStores();
    try {
      const governance = new TelegramGovernanceStore(stores.database, stores.clock, {
        ownerUserIds: ["admin-1"],
      });

      expect(governance.resolveUserRole("admin-1")).toBe("owner");
      expect(governance.resolveUserRole("user-1")).toBe("user");
      expect(governance.resolveToolCallerRole("user-1")).toBe("user");

      governance.setUserRole({
        userId: "user-2",
        role: "trusted",
        actorUserId: "admin-1",
        reason: "test",
      });
      expect(governance.resolveUserRole("user-2")).toBe("trusted");
      expect(governance.listRoles().map((record) => `${record.userId}:${record.role}:${record.source}`)).toEqual([
        "admin-1:owner:config",
        "user-2:trusted:database",
      ]);

      expect(governance.revokeUserRole({ userId: "user-2", actorUserId: "admin-1" })).toBe(true);
      expect(governance.resolveUserRole("user-2")).toBe("user");
      expect(governance.listAudit(5).map((record) => record.action)).toEqual(["revoke_role", "grant_role"]);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("protects configured owners and the last database owner", () => {
    const stores = createStores();
    try {
      const configured = new TelegramGovernanceStore(stores.database, stores.clock, {
        ownerUserIds: ["admin-1"],
      });
      expect(() => configured.revokeUserRole({ userId: "admin-1", actorUserId: "admin-1" })).toThrow(
        "Configured owner roles cannot be revoked",
      );
      expect(() => configured.setUserRole({ userId: "admin-1", role: "admin", actorUserId: "admin-1" })).toThrow(
        "Configured owner roles cannot be changed",
      );

      const databaseOnly = new TelegramGovernanceStore(stores.database, stores.clock, {
        ownerUserIds: [],
      });
      databaseOnly.setUserRole({ userId: "db-owner", role: "owner" });
      expect(() => databaseOnly.revokeUserRole({ userId: "db-owner" })).toThrow("Cannot remove the last owner");
      databaseOnly.setUserRole({ userId: "second-owner", role: "owner" });
      expect(databaseOnly.revokeUserRole({ userId: "db-owner" })).toBe(true);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("stores chat policy and applies command, tool, model, memory, and attachment limits", () => {
    const stores = createStores();
    try {
      const governance = new TelegramGovernanceStore(stores.database, stores.clock, {
        ownerUserIds: ["admin-1"],
      });
      governance.setUserRole({ userId: "trusted-1", role: "trusted", actorUserId: "admin-1" });
      const policy = parseChatGovernancePolicy(
        JSON.stringify({
          allowedRoles: ["owner", "trusted"],
          commandRoles: { help: ["trusted"], "*": ["owner"] },
          modelRefs: ["openai-codex/gpt-5.4-mini"],
          toolNames: ["mottbot_health_snapshot"],
          memoryScopes: ["session", "personal"],
          attachmentMaxFileBytes: 10,
          attachmentMaxPerMessage: 1,
        }),
      );

      governance.setChatPolicy({ chatId: "chat-1", policy, actorUserId: "admin-1" });

      expect(governance.isChatAllowed({ chatId: "chat-1", userId: "trusted-1" })).toBe(true);
      expect(governance.isChatAllowed({ chatId: "chat-1", userId: "user-1" })).toBe(false);
      expect(governance.isCommandAllowed({ chatId: "chat-1", userId: "trusted-1", command: "help" })).toBe(true);
      expect(governance.isCommandAllowed({ chatId: "chat-1", userId: "trusted-1", command: "model" })).toBe(false);
      expect(governance.hasCommandPolicy({ chatId: "chat-1", command: "model" })).toBe(true);
      expect(governance.isModelAllowed({ chatId: "chat-1", modelRef: "openai-codex/gpt-5.4-mini" })).toBe(true);
      expect(governance.isModelAllowed({ chatId: "chat-1", modelRef: "openai-codex/gpt-5.4" })).toBe(false);
      expect(governance.isToolAllowed({ chatId: "chat-1", toolName: "mottbot_health_snapshot" })).toBe(true);
      expect(governance.isToolAllowed({ chatId: "chat-1", toolName: "mottbot_recent_runs" })).toBe(false);
      expect(governance.isMemoryScopeAllowed({ chatId: "chat-1", scope: "personal" })).toBe(true);
      expect(governance.isMemoryScopeAllowed({ chatId: "chat-1", scope: "project" })).toBe(false);
      expect(
        governance.validateAttachments({
          chatId: "chat-1",
          attachments: [{ kind: "document", fileId: "a", fileName: "a.txt" }],
        }),
      ).toBeUndefined();
      expect(
        governance.validateAttachments({
          chatId: "chat-1",
          attachments: [
            { kind: "document", fileId: "a", fileName: "a.txt" },
            { kind: "document", fileId: "b", fileName: "b.txt" },
          ],
        })?.code,
      ).toBe("attachment.too_many");
      expect(
        governance.validateAttachments({
          chatId: "chat-1",
          attachments: [{ kind: "document", fileId: "big", fileName: "big.txt", fileSize: 20 }],
        })?.code,
      ).toBe("attachment.too_large");

      expect(governance.clearChatPolicy({ chatId: "chat-1", actorUserId: "admin-1" })).toBe(true);
      expect(governance.isToolAllowed({ chatId: "chat-1", toolName: "mottbot_recent_runs" })).toBe(true);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("rejects malformed chat policies", () => {
    expect(() => parseChatGovernancePolicy("[]")).toThrow("Chat policy must be a JSON object");
    expect(() => parseChatGovernancePolicy('{"allowedRoles":["missing"]}')).toThrow("unknown role");
    expect(() => parseChatGovernancePolicy('{"commandRoles":{"":["user"]}}')).toThrow("empty command");
    expect(() => parseChatGovernancePolicy('{"attachmentMaxPerMessage":0}')).toThrow("positive integer");
  });
});
