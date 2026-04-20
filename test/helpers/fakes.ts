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
import { AttachmentRecordStore } from "../../src/sessions/attachment-store.js";
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
      reactions: {
        enabled: true,
        ackEmoji: "\u{1F440}",
        removeAckAfterReply: false,
        notifications: "own",
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
    attachments: {
      cacheDir: path.join(tempDir, "attachments"),
      maxFileBytes: 20 * 1024 * 1024,
      maxTotalBytes: 30 * 1024 * 1024,
      maxPerMessage: 4,
      maxExtractedTextCharsPerFile: 40_000,
      maxExtractedTextCharsTotal: 80_000,
      csvPreviewRows: 40,
      csvPreviewColumns: 20,
      pdfMaxPages: 25,
    },
    behavior: {
      respondInGroupsOnlyWhenMentioned: true,
      editThrottleMs: 750,
      maxInboundTextChars: 12_000,
    },
    logging: {
      level: "silent",
    },
    oauth: {
      callbackHost: "127.0.0.1",
      callbackPort: 1455,
    },
    dashboard: {
      enabled: false,
      host: "127.0.0.1",
      port: 8787,
      path: "/dashboard",
      apiPath: "/api/dashboard",
    },
    tools: {
      enableSideEffectTools: false,
      approvalTtlMs: 5 * 60 * 1000,
      restartDelayMs: 60_000,
      policies: {},
      repository: {
        roots: ["."],
        deniedPaths: [],
        maxReadBytes: 40_000,
        maxSearchMatches: 100,
        maxSearchBytes: 80_000,
        commandTimeoutMs: 5_000,
      },
      localWrite: {
        roots: [path.join(tempDir, "tool-notes")],
        deniedPaths: [],
        maxWriteBytes: 20_000,
      },
      telegramSend: {
        allowedChatIds: [],
      },
      github: {
        command: "gh",
        commandTimeoutMs: 10_000,
        maxItems: 10,
        maxOutputBytes: 80_000,
      },
    },
    runtime: {
      instanceLeaseEnabled: true,
      instanceLeaseTtlMs: 2 * 60 * 1000,
      instanceLeaseRefreshMs: 30_000,
    },
    memory: {
      autoSummariesEnabled: false,
      autoSummaryRecentMessages: 12,
      autoSummaryMaxChars: 1_000,
      candidateExtractionEnabled: false,
      candidateRecentMessages: 12,
      candidateMaxPerRun: 5,
    },
    usage: {
      dailyRuns: 0,
      dailyRunsPerUser: 0,
      dailyRunsPerChat: 0,
      dailyRunsPerSession: 0,
      dailyRunsPerModel: 0,
      monthlyRuns: 0,
      monthlyRunsPerUser: 0,
      monthlyRunsPerChat: 0,
      monthlyRunsPerSession: 0,
      monthlyRunsPerModel: 0,
      warningThresholdPercent: 80,
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
      reactions: {
        ...base.telegram.reactions,
        ...overrides.telegram?.reactions,
      },
    },
    models: { ...base.models, ...overrides.models },
    auth: { ...base.auth, ...overrides.auth },
    storage: { ...base.storage, ...overrides.storage },
    attachments: { ...base.attachments, ...overrides.attachments },
    behavior: { ...base.behavior, ...overrides.behavior },
    logging: { ...base.logging, ...overrides.logging },
    oauth: { ...base.oauth, ...overrides.oauth },
    dashboard: { ...base.dashboard, ...overrides.dashboard },
    tools: { ...base.tools, ...overrides.tools },
    runtime: { ...base.runtime, ...overrides.runtime },
    memory: { ...base.memory, ...overrides.memory },
    usage: { ...base.usage, ...overrides.usage },
    security: { ...base.security, ...overrides.security },
  };
}

export function createStores(overrides: Partial<AppConfig> = {}) {
  const config = createTestConfig(overrides);
  const tempDir = path.dirname(config.storage.sqlitePath);
  const clock = new FakeClock();
  const database = new DatabaseClient(config.storage.sqlitePath);
  migrateDatabase(database);
  const authProfiles = new AuthProfileStore(database, clock, new SecretBox(config.security.masterKey));
  const sessions = new SessionStore(database, clock);
  const transcripts = new TranscriptStore(database, clock);
  const attachmentRecords = new AttachmentRecordStore(database, clock);
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
    attachmentRecords,
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
