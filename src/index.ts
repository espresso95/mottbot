#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { bootstrapApplication } from "./app/bootstrap.js";
import { loadConfig, resolveConfigPath } from "./app/config.js";
import { systemClock } from "./shared/clock.js";
import { createLogger } from "./shared/logger.js";
import { SecretBox } from "./shared/crypto.js";
import { DatabaseClient } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { buildOperationalRetentionCutoffs, pruneOperationalData } from "./db/retention.js";
import { createOperationalBackup, validateOperationalBackup } from "./ops/backup.js";
import { rotateServiceLogs, serviceLogStatus } from "./ops/logs.js";
import { AuthProfileStore } from "./codex/auth-store.js";
import { runCodexOAuthLogin } from "./codex/oauth-login.js";
import { importCodexCliAuthProfile } from "./codex/cli-auth-import.js";
import { installShutdown } from "./app/shutdown.js";
import { HealthReporter } from "./app/health.js";
import { runServiceCommand, type ServiceCommandOptions } from "./app/service.js";

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

function readOptionalStringFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1]?.trim();
  if (!value) {
    throw new Error(`${name} must be followed by a value.`);
  }
  return value;
}

function readServiceLabelFromConfig(configPath: string): string | undefined {
  if (!fs.existsSync(configPath)) {
    return undefined;
  }
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const service = (parsed as { service?: unknown }).service;
  if (!service || typeof service !== "object" || Array.isArray(service)) {
    return undefined;
  }
  const label = (service as { label?: unknown }).label;
  return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

function extractServiceCommand(args: string[]): { args: string[]; options: ServiceCommandOptions } {
  const commandArgs: string[] = [];
  let label: string | undefined;
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item) {
      continue;
    }
    if (item === "--label" || item === "--config-path") {
      const value = args[index + 1]?.trim();
      if (!value) {
        throw new Error(`${item} must be followed by a value.`);
      }
      if (item === "--label") {
        label = value;
      } else {
        configPath = value;
      }
      index += 1;
      continue;
    }
    if (item.startsWith("--label=")) {
      label = item.slice("--label=".length).trim();
      continue;
    }
    if (item.startsWith("--config-path=")) {
      configPath = item.slice("--config-path=".length).trim();
      continue;
    }
    commandArgs.push(item);
  }
  const resolvedConfigPath = path.resolve(configPath ?? resolveConfigPath());
  return {
    args: commandArgs,
    options: {
      label: label ?? readServiceLabelFromConfig(resolvedConfigPath),
      configPath: resolvedConfigPath,
    },
  };
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

async function runBackupCommand(args: string[]): Promise<void> {
  const [command = "create", ...rest] = args;
  if (command === "create") {
    const config = loadConfig();
    const result = await createOperationalBackup({
      config,
      destinationRoot: readOptionalStringFlag(rest, "--dest"),
      includeEnv: rest.includes("--include-env"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.envIncluded) {
      process.stderr.write("Warning: .env was included and may contain secrets. Do not share this backup.\n");
    }
    return;
  }
  if (command === "validate") {
    const backupDir = rest.find((arg) => !arg.startsWith("--"));
    if (!backupDir) {
      throw new Error("Usage: mottbot backup validate <backup-dir> [--target-sqlite <path>]");
    }
    const result = validateOperationalBackup({
      backupDir,
      targetSqlitePath: readOptionalStringFlag(rest, "--target-sqlite"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  throw new Error(
    "Usage: mottbot backup create [--dest <dir>] [--include-env] | validate <backup-dir> [--target-sqlite <path>]",
  );
}

function runLogsCommand(args: string[]): void {
  const [command = "status", ...rest] = args;
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(serviceLogStatus(), null, 2)}\n`);
    return;
  }
  if (command === "rotate") {
    const result = rotateServiceLogs({
      archiveRoot: readOptionalStringFlag(rest, "--archive-dir"),
      truncate: rest.includes("--truncate"),
      maxArchives: rest.includes("--max-archives") ? readPositiveIntFlag(rest, "--max-archives", 10) : undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: mottbot logs status | rotate [--archive-dir <dir>] [--truncate] [--max-archives <count>]");
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  mottbot start",
      "  mottbot auth login",
      "  mottbot auth import-cli",
      "  mottbot backup create [--dest <dir>] [--include-env]",
      "  mottbot backup validate <backup-dir> [--target-sqlite <path>]",
      "  mottbot db migrate",
      "  mottbot db prune [--older-than-days 30] [--dry-run|--yes]",
      "  mottbot logs status",
      "  mottbot logs rotate [--archive-dir <dir>] [--truncate] [--max-archives 10]",
      "  mottbot service install [--start] [--label <label>] [--config-path <file>]",
      "  mottbot service start|stop|restart|status|uninstall [--label <label>] [--config-path <file>]",
      "  mottbot restart [--label <label>] [--config-path <file>]",
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
  if (group === "backup") {
    await runBackupCommand(subcommand ? [subcommand, ...rest] : rest);
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
  if (group === "logs") {
    runLogsCommand(subcommand ? [subcommand, ...rest] : rest);
    return;
  }
  if (group === "service") {
    const serviceCommand = extractServiceCommand(subcommand ? [subcommand, ...rest] : rest);
    process.exitCode = runServiceCommand(serviceCommand.args, process.cwd(), serviceCommand.options);
    return;
  }
  if (group === "restart") {
    const serviceCommand = extractServiceCommand(
      ["restart", subcommand, ...rest].filter((value): value is string => Boolean(value)),
    );
    process.exitCode = runServiceCommand(serviceCommand.args, process.cwd(), serviceCommand.options);
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
