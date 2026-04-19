import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

const { startMock, stopMock, botCtor, botCtorSpy } = vi.hoisted(() => {
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const ctorSpy = vi.fn();
  class FakeTelegramBotServer {
    api = {};
    start = start;
    stop = stop;

    constructor(...args: unknown[]) {
      ctorSpy(...args);
    }
  }
  return {
    startMock: start,
    stopMock: stop,
    botCtor: FakeTelegramBotServer,
    botCtorSpy: ctorSpy,
  };
});

vi.mock("../../src/telegram/bot.js", () => ({
  TelegramBotServer: botCtor,
}));

describe("bootstrapApplication", () => {
  const previousEnv = { ...process.env };
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...previousEnv };
    while (dirs.length > 0) {
      removeTempDir(dirs.pop()!);
    }
  });

  it("builds the application and proxies start/stop", async () => {
    const dir = createTempDir();
    dirs.push(dir);
    const configPath = path.join(dir, "mottbot.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        auth: { preferCliImport: false },
        storage: { sqlitePath: path.join(dir, "mottbot.sqlite") },
      }),
    );
    process.env.MOTTBOT_CONFIG_PATH = configPath;
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.MOTTBOT_MASTER_KEY = "master";
    process.env.MOTTBOT_SQLITE_PATH = path.join(dir, "mottbot.sqlite");
    process.env.MOTTBOT_ATTACHMENT_CACHE_DIR = path.join(dir, "attachments");
    process.env.MOTTBOT_ADMIN_USER_IDS = "admin-1";
    process.env.MOTTBOT_ALLOWED_CHAT_IDS = "";
    process.env.MOTTBOT_PREFER_CLI_IMPORT = "false";
    process.env.MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS = "false";
    process.env.MOTTBOT_INSTANCE_LEASE_ENABLED = "true";
    process.env.MOTTBOT_DASHBOARD_ENABLED = "false";

    const { bootstrapApplication } = await import("../../src/app/bootstrap.js");
    const app = await bootstrapApplication();
    await app.start();
    await app.stop();

    expect(botCtorSpy).toHaveBeenCalledTimes(2);
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
