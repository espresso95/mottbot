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
  "MOTTBOT_SQLITE_PATH",
  "MOTTBOT_DASHBOARD_ENABLED",
  "MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS",
  "MOTTBOT_AGENTS_JSON",
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

  it("loads config from json file", () => {
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
          botToken: "file-bot-token",
          polling: false,
          adminUserIds: ["file-admin"],
          webhook: { publicUrl: "https://bot.example.com", port: 9000 },
          reactions: { notifications: "all", ackEmoji: "✅", removeAckAfterReply: true },
        },
        security: { masterKey: "file-master-key" },
        models: { default: "openai-codex/gpt-5.4-mini", transport: "sse" },
        auth: { preferCliImport: false, defaultProfile: "openai-codex:ops" },
        agents: {
          defaultId: "file",
          list: [{ id: "file", modelRef: "openai-codex/gpt-5.4-mini", profileId: "openai-codex:ops" }],
          bindings: [{ agentId: "file", chatId: "chat-1" }],
        },
        storage: { sqlitePath: "./custom.sqlite" },
        attachments: { cacheDir: "./custom-attachments", maxFileBytes: 1234 },
        behavior: { maxInboundTextChars: 2000 },
        dashboard: { enabled: false, port: 9091 },
        tools: {
          enableSideEffectTools: true,
          approvalTtlMs: 10_000,
          restartDelayMs: 30_000,
          repository: { roots: ["./file-root"] },
          localWrite: { roots: ["./file-notes"] },
          localExec: { roots: ["./file-workspace"], allowedCommands: ["node"] },
          telegramSend: { allowedChatIds: ["file-chat"] },
          github: { defaultRepository: "file-owner/file-repo", command: "file-gh", maxItems: 6 },
          microsoftTodo: { enabled: true, tenantId: "file-tenant", clientId: "file-client", defaultListId: "file-list" },
          googleDrive: { enabled: true, accessTokenEnv: "FILE_GDRIVE_TOKEN", maxBytes: 65432 },
          mcp: { servers: [{ name: "file-mcp", command: "node", args: ["server.js"], allowedTools: ["read"] }] },
        },
        runtime: { instanceLeaseEnabled: false },
        memory: { autoSummariesEnabled: true, autoSummaryRecentMessages: 16 },
        usage: { dailyRuns: 5, monthlyRunsPerModel: 20, warningThresholdPercent: 75 },
      }),
    );

    process.env.MOTTBOT_CONFIG_PATH = file;

    const config = loadConfig();
    expect(config.telegram.botToken).toBe("file-bot-token");
    expect(config.security.masterKey).toBe("file-master-key");
    expect(config.telegram.adminUserIds).toEqual(["file-admin"]);
    expect(config.dashboard.enabled).toBe(false);
    expect(config.tools.enableSideEffectTools).toBe(true);
    expect(config.models.transport).toBe("sse");
    expect(config.storage.sqlitePath).toBe(path.resolve("./custom.sqlite"));
  });

  it("does not use env overrides for runtime config", () => {
    for (const key of configEnvKeys) {
      delete process.env[key];
    }
    const dir = createTempDir();
    dirs.push(dir);
    const file = path.join(dir, "mottbot.config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        telegram: { botToken: "file-bot-token", adminUserIds: ["file-admin"] },
        security: { masterKey: "file-master-key" },
        dashboard: { enabled: false },
      }),
    );

    process.env.MOTTBOT_CONFIG_PATH = file;
    process.env.MOTTBOT_ADMIN_USER_IDS = "env-admin";
    process.env.MOTTBOT_DASHBOARD_ENABLED = "true";

    const config = loadConfig();
    expect(config.telegram.adminUserIds).toEqual(["file-admin"]);
    expect(config.dashboard.enabled).toBe(false);
  });

  it("synthesizes the default agent when no agents are configured", () => {
    for (const key of configEnvKeys) {
      delete process.env[key];
    }
    const dir = createTempDir();
    dirs.push(dir);
    const file = path.join(dir, "mottbot.config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        telegram: { botToken: "bot-token" },
        security: { masterKey: "master" },
      }),
    );

    process.env.MOTTBOT_CONFIG_PATH = file;

    const config = loadConfig();
    expect(config.agents).toEqual({
      defaultId: "main",
      list: [
        {
          id: "main",
          profileId: "openai-codex:default",
          modelRef: "openai-codex/gpt-5.4",
          fastMode: false,
        },
      ],
      bindings: [],
    });
  });

  it("rejects bindings that reference unknown agents", () => {
    for (const key of configEnvKeys) {
      delete process.env[key];
    }
    const dir = createTempDir();
    dirs.push(dir);
    const file = path.join(dir, "mottbot.config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        telegram: { botToken: "bot-token" },
        security: { masterKey: "master" },
        agents: {
          defaultId: "main",
          list: [{ id: "main" }],
          bindings: [{ agentId: "missing", chatId: "chat-1" }],
        },
      }),
    );

    process.env.MOTTBOT_CONFIG_PATH = file;

    expect(() => loadConfig()).toThrow(/unknown agent/i);
  });
});
