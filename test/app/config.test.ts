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
  "MOTTBOT_ATTACHMENT_MAX_PER_MESSAGE",
  "MOTTBOT_GROUP_MENTION_ONLY",
  "MOTTBOT_EDIT_THROTTLE_MS",
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
        },
        models: { default: "openai-codex/gpt-5.4-mini" },
        auth: { preferCliImport: false },
        storage: { sqlitePath: "./custom.sqlite" },
        attachments: { maxFileBytes: 1234 },
        dashboard: { enabled: false, port: 9091 },
      }),
    );

    process.env.MOTTBOT_CONFIG_PATH = file;
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.MOTTBOT_MASTER_KEY = "master";
    process.env.MOTTBOT_ADMIN_USER_IDS = "env-admin-1,env-admin-2";
    process.env.MOTTBOT_ATTACHMENT_CACHE_DIR = "./custom-attachments";
    process.env.MOTTBOT_DASHBOARD_HOST = "0.0.0.0";

    const config = loadConfig();
    expect(config.telegram.botToken).toBe("bot-token");
    expect(config.telegram.adminUserIds).toEqual(["env-admin-1", "env-admin-2"]);
    expect(config.telegram.webhook.publicUrl).toBe("https://bot.example.com");
    expect(config.telegram.webhook.port).toBe(9000);
    expect(config.models.default).toBe("openai-codex/gpt-5.4-mini");
    expect(config.auth.preferCliImport).toBe(false);
    expect(config.storage.sqlitePath).toBe(path.resolve("./custom.sqlite"));
    expect(config.attachments.cacheDir).toBe(path.resolve("./custom-attachments"));
    expect(config.attachments.maxFileBytes).toBe(1234);
    expect(config.attachments.maxPerMessage).toBe(4);
    expect(config.dashboard.enabled).toBe(false);
    expect(config.dashboard.port).toBe(9091);
    expect(config.dashboard.host).toBe("0.0.0.0");
  });
});
