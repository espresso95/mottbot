import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/app/config.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

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
    const dir = createTempDir();
    dirs.push(dir);
    const file = path.join(dir, "mottbot.config.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        telegram: { polling: false, adminUserIds: ["file-admin"] },
        models: { default: "openai-codex/gpt-5.4-mini" },
        auth: { preferCliImport: false },
        storage: { sqlitePath: "./custom.sqlite" },
      }),
    );

    process.env.MOTTBOT_CONFIG_PATH = file;
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.MOTTBOT_MASTER_KEY = "master";
    process.env.MOTTBOT_ADMIN_USER_IDS = "env-admin-1,env-admin-2";

    const config = loadConfig();
    expect(config.telegram.botToken).toBe("bot-token");
    expect(config.telegram.adminUserIds).toEqual(["env-admin-1", "env-admin-2"]);
    expect(config.models.default).toBe("openai-codex/gpt-5.4-mini");
    expect(config.auth.preferCliImport).toBe(false);
    expect(config.storage.sqlitePath).toBe(path.resolve("./custom.sqlite"));
  });
});
