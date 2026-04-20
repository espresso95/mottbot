import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOperationalBackup, defaultBackupName, validateOperationalBackup } from "../../src/ops/backup.js";
import { createStores } from "../helpers/fakes.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

describe("operational backups", () => {
  it("creates a timestamped SQLite backup with redacted config and excludes env by default", async () => {
    const stores = createStores();
    const backupRoot = createTempDir();
    const envPath = path.join(stores.tempDir, ".env");
    try {
      stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=secret-token\n", "utf8");

      const result = await createOperationalBackup({
        config: stores.config,
        destinationRoot: backupRoot,
        envPath,
        now: new Date("2026-04-20T00:00:00.000Z"),
      });

      expect(path.basename(result.backupDir)).toBe(defaultBackupName(new Date("2026-04-20T00:00:00.000Z")));
      expect(result.integrityCheck).toBe("ok");
      expect(result.envIncluded).toBe(false);
      expect(fs.existsSync(path.join(result.backupDir, ".env"))).toBe(false);
      expect(fs.readFileSync(path.join(result.backupDir, "config.redacted.json"), "utf8")).not.toContain("test-token");
      expect(validateOperationalBackup({ backupDir: result.backupDir }).ok).toBe(true);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
      removeTempDir(backupRoot);
    }
  });

  it("can explicitly include env and warns during validation when restoring over an existing database", async () => {
    const stores = createStores();
    const backupRoot = createTempDir();
    const envPath = path.join(stores.tempDir, ".env");
    try {
      fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=secret-token\n", "utf8");
      const result = await createOperationalBackup({
        config: stores.config,
        destinationRoot: backupRoot,
        includeEnv: true,
        envPath,
      });

      expect(result.envIncluded).toBe(true);
      expect(fs.existsSync(path.join(result.backupDir, ".env"))).toBe(true);
      const validation = validateOperationalBackup({
        backupDir: result.backupDir,
        targetSqlitePath: stores.config.storage.sqlitePath,
      });
      expect(validation.ok).toBe(true);
      expect(validation.warnings.join("\n")).toContain("Restore target already exists");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
      removeTempDir(backupRoot);
    }
  });

  it("rejects duplicate destinations and reports missing backup files", async () => {
    const stores = createStores();
    const backupRoot = createTempDir();
    const now = new Date("2026-04-20T00:00:00.000Z");
    try {
      const first = await createOperationalBackup({
        config: stores.config,
        destinationRoot: backupRoot,
        now,
      });
      await expect(
        createOperationalBackup({
          config: stores.config,
          destinationRoot: backupRoot,
          now,
        }),
      ).rejects.toThrow("Backup destination already exists");

      fs.rmSync(path.join(first.backupDir, "mottbot.sqlite"));
      const validation = validateOperationalBackup({ backupDir: first.backupDir });
      expect(validation.ok).toBe(false);
      expect(validation.errors.join("\n")).toContain("Missing backup file");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
      removeTempDir(backupRoot);
    }
  });

  it("fails validation clearly when the manifest is missing", () => {
    const backupRoot = createTempDir();
    try {
      const validation = validateOperationalBackup({ backupDir: backupRoot });
      expect(validation.ok).toBe(false);
      expect(validation.errors[0]).toContain("Missing manifest");
    } finally {
      removeTempDir(backupRoot);
    }
  });
});
