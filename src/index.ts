#!/usr/bin/env node
import { bootstrapApplication } from "./app/bootstrap.js";
import { loadConfig } from "./app/config.js";
import { systemClock } from "./shared/clock.js";
import { createLogger } from "./shared/logger.js";
import { SecretBox } from "./shared/crypto.js";
import { DatabaseClient } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { AuthProfileStore } from "./codex/auth-store.js";
import { runCodexOAuthLogin } from "./codex/oauth-login.js";
import { importCodexCliAuthProfile } from "./codex/cli-auth-import.js";
import { installShutdown } from "./app/shutdown.js";
import { HealthReporter } from "./app/health.js";

async function runStart(): Promise<void> {
  const app = await bootstrapApplication();
  installShutdown({
    logger: app.logger,
    onShutdown: async () => {
      await app.stop();
    },
  });
  await app.start();
}

async function runAuthLogin(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logging.level);
  const database = new DatabaseClient(config.storage.sqlitePath);
  try {
    migrateDatabase(database);
    const authStore = new AuthProfileStore(database, systemClock, new SecretBox(config.security.masterKey));
    const profileId = await runCodexOAuthLogin({
      config,
      authStore,
      logger,
    });
    logger.info({ profileId }, "Stored OpenAI Codex OAuth profile.");
  } finally {
    database.close();
  }
}

async function runAuthImportCli(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logging.level);
  const database = new DatabaseClient(config.storage.sqlitePath);
  try {
    migrateDatabase(database);
    const authStore = new AuthProfileStore(database, systemClock, new SecretBox(config.security.masterKey));
    const result = importCodexCliAuthProfile({
      store: authStore,
      profileId: config.auth.defaultProfile,
    });
    if (!result.imported) {
      throw new Error("No Codex CLI auth.json with ChatGPT credentials was found.");
    }
    logger.info({ profileId: result.profileId }, "Imported Codex CLI auth profile.");
  } finally {
    database.close();
  }
}

async function runHealth(): Promise<void> {
  const config = loadConfig();
  const database = new DatabaseClient(config.storage.sqlitePath);
  try {
    migrateDatabase(database);
    const authStore = new AuthProfileStore(database, systemClock, new SecretBox(config.security.masterKey));
    if (config.auth.preferCliImport) {
      importCodexCliAuthProfile({
        store: authStore,
        profileId: config.auth.defaultProfile,
      });
    }
    const health = new HealthReporter(config, database, authStore, systemClock);
    process.stdout.write(`${health.formatForText()}\n`);
  } finally {
    database.close();
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  mottbot start",
      "  mottbot auth login",
      "  mottbot auth import-cli",
      "  mottbot db migrate",
      "  mottbot health",
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
  const [group = "start", subcommand] = args;

  if (group === "start") {
    await runStart();
    return;
  }
  if (group === "auth" && subcommand === "login") {
    await runAuthLogin();
    return;
  }
  if (group === "auth" && subcommand === "import-cli") {
    await runAuthImportCli();
    return;
  }
  if (group === "db" && subcommand === "migrate") {
    const config = loadConfig();
    const database = new DatabaseClient(config.storage.sqlitePath);
    migrateDatabase(database);
    database.close();
    return;
  }
  if (group === "health") {
    await runHealth();
    return;
  }
  printHelp();
  process.exitCode = 1;
}

await main();
