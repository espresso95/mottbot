#!/usr/bin/env node
import { bootstrapApplication } from "./app/bootstrap.js";
import { loadConfig } from "./app/config.js";
import { systemClock } from "./shared/clock.js";
import { createLogger } from "./shared/logger.js";
import { SecretBox } from "./shared/crypto.js";
import { DatabaseClient } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { buildOperationalRetentionCutoffs, pruneOperationalData } from "./db/retention.js";
import { AuthProfileStore } from "./codex/auth-store.js";
import { runCodexOAuthLogin } from "./codex/oauth-login.js";
import { importCodexCliAuthProfile } from "./codex/cli-auth-import.js";
import { installShutdown } from "./app/shutdown.js";
import { HealthReporter } from "./app/health.js";
import { runServiceCommand } from "./app/service.js";

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

function readPositiveIntFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  const raw = args[index + 1];
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be followed by a positive integer.`);
  }
  return parsed;
}

async function runDbPrune(args: string[]): Promise<void> {
  const config = loadConfig();
  const database = new DatabaseClient(config.storage.sqlitePath);
  try {
    migrateDatabase(database);
    const olderThanDays = readPositiveIntFlag(args, "--older-than-days", 30);
    const dryRun = !args.includes("--yes") || args.includes("--dry-run");
    const result = pruneOperationalData({
      database,
      cutoffs: buildOperationalRetentionCutoffs({
        now: systemClock.now(),
        olderThanDays,
      }),
      dryRun,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (dryRun) {
      process.stdout.write("Dry run only. Re-run with --yes to delete matching rows.\n");
    }
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
      "  mottbot db prune [--older-than-days 30] [--dry-run|--yes]",
      "  mottbot service install [--start]",
      "  mottbot service start|stop|restart|status|uninstall",
      "  mottbot restart",
      "  mottbot health",
    ].join("\n") + "\n",
  );
}

async function main(): Promise<void> {
  const [, , ...args] = process.argv;
  const [group = "start", subcommand, ...rest] = args;

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
  if (group === "db" && subcommand === "prune") {
    await runDbPrune(rest);
    return;
  }
  if (group === "service") {
    process.exitCode = runServiceCommand(subcommand ? [subcommand, ...rest] : rest);
    return;
  }
  if (group === "restart") {
    process.exitCode = runServiceCommand(["restart", subcommand, ...rest].filter((value): value is string => Boolean(value)));
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
