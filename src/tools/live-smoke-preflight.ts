#!/usr/bin/env node
import { loadConfig } from "../app/config.js";
import { HealthReporter } from "../app/health.js";
import { AuthProfileStore } from "../codex/auth-store.js";
import { DatabaseClient } from "../db/client.js";
import { migrateDatabase } from "../db/migrate.js";
import { systemClock } from "../shared/clock.js";
import { SecretBox } from "../shared/crypto.js";

type MigrationVersionRow = {
  version: number;
  name: string;
};

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function countRows(database: DatabaseClient, table: string): number {
  return database.db
    .prepare<unknown[], { count: number }>(`select count(*) as count from ${table}`)
    .get()?.count ?? 0;
}

function readMigrations(database: DatabaseClient): MigrationVersionRow[] {
  return database.db
    .prepare<unknown[], MigrationVersionRow>("select version, name from schema_migrations order by version")
    .all();
}

function main(): void {
  if (process.env.MOTTBOT_LIVE_SMOKE_ENABLED !== "true") {
    printJson({
      status: "skipped",
      reason: "Set MOTTBOT_LIVE_SMOKE_ENABLED=true to validate a configured live smoke environment.",
    });
    return;
  }

  const config = loadConfig();
  const database = new DatabaseClient(config.storage.sqlitePath);
  try {
    migrateDatabase(database);
    const authStore = new AuthProfileStore(database, systemClock, new SecretBox(config.security.masterKey));
    const authProfiles = authStore.list();
    const defaultProfilePresent = authProfiles.some((profile) => profile.profileId === config.auth.defaultProfile);
    const health = new HealthReporter(config, database, authStore, systemClock).snapshot();
    const issues = [
      ...(defaultProfilePresent ? [] : [`Default auth profile is missing: ${config.auth.defaultProfile}`]),
      ...(config.telegram.adminUserIds.length > 0 ? [] : ["MOTTBOT_ADMIN_USER_IDS is empty."]),
      ...(!config.telegram.polling && !config.telegram.webhook.publicUrl
        ? ["Webhook mode requires telegram.webhook.publicUrl or MOTTBOT_TELEGRAM_WEBHOOK_URL."]
        : []),
    ];

    printJson({
      status: issues.length === 0 ? "ready" : "blocked",
      issues,
      configPath: config.configPath,
      mode: config.telegram.polling ? "polling" : "webhook",
      sqlitePath: config.storage.sqlitePath,
      attachmentCacheDir: config.attachments.cacheDir,
      defaultProfile: config.auth.defaultProfile,
      authProfiles: authProfiles.length,
      sessions: health.sessions,
      interruptedRuns: health.interruptedRuns,
      processedUpdates: health.processedUpdates,
      queuedRuns: countRows(database, "run_queue"),
      migrations: readMigrations(database),
    });

    if (issues.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    database.close();
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ status: "failed", error: message });
  process.exitCode = 1;
}
