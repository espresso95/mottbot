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

type TelegramBotSummary = {
  id: number;
  firstName?: string;
  username?: string;
  canJoinGroups?: boolean;
  canReadAllGroupMessages?: boolean;
};

type TelegramOutboundCheck =
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "sent";
      chatId: string;
      messageId: number;
    };

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

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

async function readTelegramBot(token: string): Promise<TelegramBotSummary> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = asObject(await response.json());
  const result = asObject(parsed?.result);
  const description = typeof parsed?.description === "string" ? parsed.description : response.statusText;
  if (!response.ok || parsed?.ok !== true || !result) {
    throw new Error(`Telegram getMe failed: ${description || "unknown error"}`);
  }
  if (typeof result.id !== "number") {
    throw new Error("Telegram getMe returned a bot result without a numeric id.");
  }
  return {
    id: result.id,
    ...(typeof result.first_name === "string" ? { firstName: result.first_name } : {}),
    ...(typeof result.username === "string" ? { username: result.username } : {}),
    ...(typeof result.can_join_groups === "boolean" ? { canJoinGroups: result.can_join_groups } : {}),
    ...(typeof result.can_read_all_group_messages === "boolean"
      ? { canReadAllGroupMessages: result.can_read_all_group_messages }
      : {}),
  };
}

async function sendTelegramSmokeMessage(params: {
  token: string;
  chatId: string;
  text: string;
}): Promise<TelegramOutboundCheck> {
  const response = await fetch(`https://api.telegram.org/bot${params.token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: params.chatId,
      text: params.text,
      disable_notification: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = asObject(await response.json());
  const result = asObject(parsed?.result);
  const description = typeof parsed?.description === "string" ? parsed.description : response.statusText;
  if (!response.ok || parsed?.ok !== true || !result) {
    throw new Error(`Telegram sendMessage failed: ${description || "unknown error"}`);
  }
  if (typeof result.message_id !== "number") {
    throw new Error("Telegram sendMessage returned a result without message_id.");
  }
  return {
    status: "sent",
    chatId: params.chatId,
    messageId: result.message_id,
  };
}

async function main(): Promise<void> {
  if (process.env.MOTTBOT_LIVE_SMOKE_ENABLED !== "true") {
    printJson({
      status: "skipped",
      reason: "Set MOTTBOT_LIVE_SMOKE_ENABLED=true to validate a configured live smoke environment.",
    });
    return;
  }

  const config = loadConfig();
  const telegramBot = await readTelegramBot(config.telegram.botToken);
  const liveTestChatId = process.env.MOTTBOT_LIVE_TEST_CHAT_ID?.trim();
  const outboundCheck = liveTestChatId
    ? await sendTelegramSmokeMessage({
        token: config.telegram.botToken,
        chatId: liveTestChatId,
        text: process.env.MOTTBOT_LIVE_TEST_MESSAGE?.trim() || "Mottbot live smoke outbound check.",
      })
    : ({
        status: "skipped",
        reason: "Set MOTTBOT_LIVE_TEST_CHAT_ID to send a guarded outbound Telegram check.",
      } satisfies TelegramOutboundCheck);
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
      telegramBot,
      outboundCheck,
      sqlitePath: config.storage.sqlitePath,
      attachmentCacheDir: config.attachments.cacheDir,
      defaultProfile: config.auth.defaultProfile,
      authProfiles: authProfiles.length,
      sessions: health.sessions,
      activeRuns: health.activeRuns,
      interruptedRuns: health.interruptedRuns,
      staleOutboxMessages: health.staleOutboxMessages,
      processedUpdates: health.processedUpdates,
      queuedRuns: health.queuedRuns,
      runQueueRows: countRows(database, "run_queue"),
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
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ status: "failed", error: message });
  process.exitCode = 1;
}
