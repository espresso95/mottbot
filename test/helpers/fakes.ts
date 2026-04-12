import path from "node:path";
import type { AppConfig } from "../../src/app/config.js";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import type { Clock } from "../../src/shared/clock.js";
import { SecretBox } from "../../src/shared/crypto.js";
import { createLogger } from "../../src/shared/logger.js";
import type { InboundEvent } from "../../src/telegram/types.js";
import { TelegramMessageStore } from "../../src/telegram/message-store.js";
import { TelegramUpdateStore } from "../../src/telegram/update-store.js";
import { AuthProfileStore } from "../../src/codex/auth-store.js";
import { RunStore } from "../../src/runs/run-store.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { TranscriptStore } from "../../src/sessions/transcript-store.js";
import { HealthReporter } from "../../src/app/health.js";
import { createTempDir } from "./tmp.js";

export class FakeClock implements Clock {
  constructor(private value = 1_700_000_000_000) {}

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

export function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const tempDir = createTempDir();
  const base: AppConfig = {
    configPath: path.join(tempDir, "mottbot.config.json"),
    telegram: {
      botToken: "test-token",
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      polling: true,
      adminUserIds: ["admin-1"],
      allowedChatIds: [],
      webhook: {
        publicUrl: "https://example.com",
        path: "/telegram/webhook",
        host: "127.0.0.1",
        port: 8080,
        secretToken: "secret",
      },
    },
    models: {
      default: "openai-codex/gpt-5.4",
      transport: "auto",
    },
    auth: {
      defaultProfile: "openai-codex:default",
      preferCliImport: true,
    },
    storage: {
      sqlitePath: path.join(tempDir, "mottbot.sqlite"),
    },
    behavior: {
      respondInGroupsOnlyWhenMentioned: true,
      editThrottleMs: 750,
    },
    logging: {
      level: "silent",
    },
    oauth: {
      callbackHost: "127.0.0.1",
      callbackPort: 1455,
    },
    security: {
      masterKey: "test-master-key",
    },
  };
  return {
    ...base,
    ...overrides,
    telegram: {
      ...base.telegram,
      ...overrides.telegram,
      webhook: {
        ...base.telegram.webhook,
        ...overrides.telegram?.webhook,
      },
    },
    models: { ...base.models, ...overrides.models },
    auth: { ...base.auth, ...overrides.auth },
    storage: { ...base.storage, ...overrides.storage },
    behavior: { ...base.behavior, ...overrides.behavior },
    logging: { ...base.logging, ...overrides.logging },
    oauth: { ...base.oauth, ...overrides.oauth },
    security: { ...base.security, ...overrides.security },
  };
}

export function createStores() {
  const config = createTestConfig();
  const tempDir = path.dirname(config.storage.sqlitePath);
  const clock = new FakeClock();
  const database = new DatabaseClient(config.storage.sqlitePath);
  migrateDatabase(database);
  const authProfiles = new AuthProfileStore(database, clock, new SecretBox(config.security.masterKey));
  const sessions = new SessionStore(database, clock);
  const transcripts = new TranscriptStore(database, clock);
  const runs = new RunStore(database, clock);
  const messageStore = new TelegramMessageStore(database, clock);
  const updateStore = new TelegramUpdateStore(database, clock);
  return {
    tempDir,
    config,
    clock,
    database,
    authProfiles,
    sessions,
    transcripts,
    runs,
    messageStore,
    updateStore,
    health: new HealthReporter(config, database, authProfiles, clock),
    logger: createLogger("silent"),
  };
}

export function createInboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    updateId: 1,
    chatId: "chat-1",
    chatType: "private",
    messageId: 42,
    fromUserId: "user-1",
    fromUsername: "user1",
    text: "hello",
    entities: [],
    attachments: [],
    mentionsBot: false,
    isCommand: false,
    arrivedAt: 1_700_000_000_000,
    ...overrides,
  };
}
