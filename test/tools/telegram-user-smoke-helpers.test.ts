import { describe, expect, it } from "vitest";
import {
  buildTelegramUserSmokeConfig,
  isTransientBotStatus,
  normalizeBotUsername,
  parseBooleanEnv,
  parsePositiveIntegerEnv,
} from "../../src/tools/telegram-user-smoke-helpers.js";

describe("telegram user smoke helpers", () => {
  it("normalizes bot usernames", () => {
    expect(normalizeBotUsername("@StartupMottBot")).toBe("StartupMottBot");
    expect(() => normalizeBotUsername("bad")).toThrow("Telegram username");
  });

  it("parses guarded env values", () => {
    expect(parsePositiveIntegerEnv({}, "TIMEOUT", 10)).toBe(10);
    expect(parsePositiveIntegerEnv({ TIMEOUT: "25" }, "TIMEOUT", 10)).toBe(25);
    expect(() => parsePositiveIntegerEnv({ TIMEOUT: "0" }, "TIMEOUT", 10)).toThrow("positive integer");

    expect(parseBooleanEnv({}, "WAIT", true)).toBe(true);
    expect(parseBooleanEnv({ WAIT: "false" }, "WAIT", true)).toBe(false);
    expect(parseBooleanEnv({ WAIT: "yes" }, "WAIT", false)).toBe(true);
    expect(() => parseBooleanEnv({ WAIT: "maybe" }, "WAIT", false)).toThrow("true or false");
  });

  it("builds smoke config from env", () => {
    expect(
      buildTelegramUserSmokeConfig({
        fallbackBotUsername: "StartupMottBot",
        env: {
          TELEGRAM_API_ID: "12345",
          TELEGRAM_API_HASH: "hash",
          MOTTBOT_USER_SMOKE_MESSAGE: "hello",
          MOTTBOT_USER_SMOKE_WAIT_FOR_REPLY: "false",
        },
      }),
    ).toEqual({
      apiId: 12345,
      apiHash: "hash",
      botUsername: "StartupMottBot",
      message: "hello",
      sessionPath: "./data/telegram-user-smoke.session",
      timeoutMs: 90_000,
      pollIntervalMs: 2_000,
      stableReplyMs: 4_000,
      waitForReply: false,
    });
  });

  it("identifies transient bot status messages", () => {
    expect(isTransientBotStatus("Working...")).toBe(true);
    expect(isTransientBotStatus("Preparing tool: mottbot_health_snapshot...")).toBe(true);
    expect(isTransientBotStatus("Running tool: mottbot_health_snapshot...")).toBe(true);
    expect(isTransientBotStatus("Tool mottbot_health_snapshot completed. Continuing...")).toBe(true);
    expect(isTransientBotStatus("Health is ok.")).toBe(false);
  });
});
