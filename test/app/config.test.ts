import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/app/config.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

const configEnvKeys = [
  "MOTTBOT_CONFIG_PATH",
  "TELEGRAM_BOT_TOKEN",
  "MOTTBOT_MASTER_KEY",
  "MOTTBOT_ADMIN_USER_IDS",
  "MOTTBOT_ALLOWED_CHAT_IDS",
  "MOTTBOT_DEFAULT_MODEL",
  "MOTTBOT_TRANSPORT",
  "MOTTBOT_DEFAULT_PROFILE",
  "MOTTBOT_PREFER_CLI_IMPORT",
  "MOTTBOT_SQLITE_PATH",
  "MOTTBOT_ATTACHMENT_CACHE_DIR",
  "MOTTBOT_ATTACHMENT_MAX_FILE_BYTES",
  "MOTTBOT_ATTACHMENT_MAX_TOTAL_BYTES",
  "MOTTBOT_ATTACHMENT_MAX_PER_MESSAGE",
  "MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_PER_FILE",
  "MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_TOTAL",
  "MOTTBOT_ATTACHMENT_CSV_PREVIEW_ROWS",
  "MOTTBOT_ATTACHMENT_CSV_PREVIEW_COLUMNS",
  "MOTTBOT_ATTACHMENT_PDF_MAX_PAGES",
  "MOTTBOT_GROUP_MENTION_ONLY",
  "MOTTBOT_EDIT_THROTTLE_MS",
  "MOTTBOT_MAX_INBOUND_TEXT_CHARS",
  "MOTTBOT_LOG_LEVEL",
  "MOTTBOT_OAUTH_CALLBACK_HOST",
  "MOTTBOT_OAUTH_CALLBACK_PORT",
  "MOTTBOT_DASHBOARD_ENABLED",
  "MOTTBOT_DASHBOARD_HOST",
  "MOTTBOT_DASHBOARD_PORT",
  "MOTTBOT_DASHBOARD_PATH",
  "MOTTBOT_DASHBOARD_API_PATH",
  "MOTTBOT_DASHBOARD_AUTH_TOKEN",
  "MOTTBOT_TELEGRAM_POLLING",
  "MOTTBOT_TELEGRAM_WEBHOOK_URL",
  "MOTTBOT_TELEGRAM_WEBHOOK_PATH",
  "MOTTBOT_TELEGRAM_WEBHOOK_HOST",
  "MOTTBOT_TELEGRAM_WEBHOOK_PORT",
  "MOTTBOT_TELEGRAM_WEBHOOK_SECRET_TOKEN",
  "MOTTBOT_TELEGRAM_REACTIONS_ENABLED",
  "MOTTBOT_TELEGRAM_ACK_REACTION",
  "MOTTBOT_TELEGRAM_REMOVE_ACK_AFTER_REPLY",
  "MOTTBOT_TELEGRAM_REACTION_NOTIFICATIONS",
  "MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS",
  "MOTTBOT_TOOL_APPROVAL_TTL_MS",
  "MOTTBOT_RESTART_TOOL_DELAY_MS",
  "MOTTBOT_TOOL_POLICIES_JSON",
  "MOTTBOT_REPOSITORY_ROOTS",
  "MOTTBOT_REPOSITORY_DENIED_PATHS",
  "MOTTBOT_REPOSITORY_MAX_READ_BYTES",
  "MOTTBOT_REPOSITORY_MAX_SEARCH_MATCHES",
  "MOTTBOT_REPOSITORY_MAX_SEARCH_BYTES",
  "MOTTBOT_REPOSITORY_COMMAND_TIMEOUT_MS",
  "MOTTBOT_INSTANCE_LEASE_ENABLED",
  "MOTTBOT_INSTANCE_LEASE_TTL_MS",
  "MOTTBOT_INSTANCE_LEASE_REFRESH_MS",
  "MOTTBOT_AUTO_MEMORY_SUMMARIES",
  "MOTTBOT_AUTO_MEMORY_SUMMARY_RECENT_MESSAGES",
  "MOTTBOT_AUTO_MEMORY_SUMMARY_MAX_CHARS",
];

describe("loadConfig", () => {
  const previousEnv = { ...process.env };
  const dirs: string[] = [];

  afterEach(() => {
    process.env = { ...previousEnv };
    while (dirs.length > 0) {
      removeTempDir(dirs.pop()!);
    }
  });

  it("loads config from file and env", () => {
    for (const key of configEnvKeys) {
      delete process.env[key];
    }
    const dir = createTempDir();
    dirs.push(dir);
    const file = path.join(dir, "mottbot.config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        telegram: {
          polling: false,
          adminUserIds: ["file-admin"],
          webhook: { publicUrl: "https://bot.example.com", port: 9000 },
          reactions: { notifications: "all" },
        },
        models: { default: "openai-codex/gpt-5.4-mini" },
        auth: { preferCliImport: false },
        storage: { sqlitePath: "./custom.sqlite" },
        attachments: {
          maxFileBytes: 1234,
          maxTotalBytes: 4321,
          maxExtractedTextCharsPerFile: 111,
          maxExtractedTextCharsTotal: 222,
          csvPreviewRows: 7,
          csvPreviewColumns: 8,
          pdfMaxPages: 9,
        },
        behavior: { maxInboundTextChars: 2000 },
        dashboard: { enabled: false, port: 9091 },
        tools: {
          approvalTtlMs: 10_000,
          policies: {
            mottbot_recent_runs: {
              allowedRoles: ["admin"],
              maxOutputBytes: 1_000,
            },
          },
          repository: {
            roots: ["./file-root"],
            deniedPaths: ["file-secret"],
            maxReadBytes: 1111,
            maxSearchMatches: 22,
            maxSearchBytes: 3333,
            commandTimeoutMs: 4444,
          },
        },
        runtime: { instanceLeaseEnabled: false },
        memory: { autoSummaryRecentMessages: 16 },
      }),
    );

    process.env.MOTTBOT_CONFIG_PATH = file;
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.MOTTBOT_MASTER_KEY = "master";
    process.env.MOTTBOT_ADMIN_USER_IDS = "env-admin-1,env-admin-2";
    process.env.MOTTBOT_ATTACHMENT_CACHE_DIR = "./custom-attachments";
    process.env.MOTTBOT_DASHBOARD_HOST = "0.0.0.0";
    process.env.MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS = "true";
    process.env.MOTTBOT_RESTART_TOOL_DELAY_MS = "30000";
    process.env.MOTTBOT_TOOL_POLICIES_JSON = JSON.stringify({
      mottbot_health_snapshot: {
        allowedRoles: ["admin", "user"],
        allowedChatIds: ["chat-1"],
        requiresApproval: false,
        maxOutputBytes: 1234,
      },
    });
    process.env.MOTTBOT_REPOSITORY_ROOTS = "./env-root,./env-root-2";
    process.env.MOTTBOT_REPOSITORY_DENIED_PATHS = "env-secret,private";
    process.env.MOTTBOT_REPOSITORY_MAX_READ_BYTES = "2222";
    process.env.MOTTBOT_REPOSITORY_MAX_SEARCH_MATCHES = "33";
    process.env.MOTTBOT_REPOSITORY_MAX_SEARCH_BYTES = "4444";
    process.env.MOTTBOT_REPOSITORY_COMMAND_TIMEOUT_MS = "5555";
    process.env.MOTTBOT_AUTO_MEMORY_SUMMARIES = "true";
    process.env.MOTTBOT_AUTO_MEMORY_SUMMARY_MAX_CHARS = "800";
    process.env.MOTTBOT_TELEGRAM_ACK_REACTION = "\u{2705}";
    process.env.MOTTBOT_TELEGRAM_REMOVE_ACK_AFTER_REPLY = "true";

    const config = loadConfig();
    expect(config.telegram.botToken).toBe("bot-token");
    expect(config.telegram.adminUserIds).toEqual(["env-admin-1", "env-admin-2"]);
    expect(config.telegram.webhook.publicUrl).toBe("https://bot.example.com");
    expect(config.telegram.webhook.port).toBe(9000);
    expect(config.telegram.reactions.enabled).toBe(true);
    expect(config.telegram.reactions.ackEmoji).toBe("\u{2705}");
    expect(config.telegram.reactions.removeAckAfterReply).toBe(true);
    expect(config.telegram.reactions.notifications).toBe("all");
    expect(config.models.default).toBe("openai-codex/gpt-5.4-mini");
    expect(config.auth.preferCliImport).toBe(false);
    expect(config.storage.sqlitePath).toBe(path.resolve("./custom.sqlite"));
    expect(config.attachments.cacheDir).toBe(path.resolve("./custom-attachments"));
    expect(config.attachments.maxFileBytes).toBe(1234);
    expect(config.attachments.maxTotalBytes).toBe(4321);
    expect(config.attachments.maxPerMessage).toBe(4);
    expect(config.attachments.maxExtractedTextCharsPerFile).toBe(111);
    expect(config.attachments.maxExtractedTextCharsTotal).toBe(222);
    expect(config.attachments.csvPreviewRows).toBe(7);
    expect(config.attachments.csvPreviewColumns).toBe(8);
    expect(config.attachments.pdfMaxPages).toBe(9);
    expect(config.behavior.maxInboundTextChars).toBe(2000);
    expect(config.dashboard.enabled).toBe(false);
    expect(config.dashboard.port).toBe(9091);
    expect(config.dashboard.host).toBe("0.0.0.0");
    expect(config.tools.enableSideEffectTools).toBe(true);
    expect(config.tools.approvalTtlMs).toBe(10_000);
    expect(config.tools.restartDelayMs).toBe(30_000);
    expect(config.tools.policies).toEqual({
      mottbot_health_snapshot: {
        allowedRoles: ["admin", "user"],
        allowedChatIds: ["chat-1"],
        requiresApproval: false,
        maxOutputBytes: 1234,
      },
    });
    expect(config.tools.repository).toEqual({
      roots: ["./env-root", "./env-root-2"],
      deniedPaths: ["env-secret", "private"],
      maxReadBytes: 2222,
      maxSearchMatches: 33,
      maxSearchBytes: 4444,
      commandTimeoutMs: 5555,
    });
    expect(config.runtime.instanceLeaseEnabled).toBe(false);
    expect(config.memory.autoSummariesEnabled).toBe(true);
    expect(config.memory.autoSummaryRecentMessages).toBe(16);
    expect(config.memory.autoSummaryMaxChars).toBe(800);
  });
});
