import { describe, expect, it } from "vitest";
import {
  RUN_STATUS_TEXT,
  formatToolCompletedStatus,
  formatToolPreparingStatus,
  formatToolRunningStatus,
} from "../../src/shared/run-status.js";
import {
  buildTelegramUserSmokeConfig,
  evaluateTelegramUserSmokeStatus,
  isTransientBotStatus,
  normalizeBotUsername,
  parseBooleanEnv,
  parsePositiveIntegerEnv,
} from "../../scripts/smoke/telegram-user-smoke-helpers.js";

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
          MOTTBOT_USER_SMOKE_EXPECT_REPLY: "false",
          MOTTBOT_USER_SMOKE_EXPECT_REPLY_CONTAINS: "received",
        },
      }),
    ).toEqual({
      apiId: 12345,
      apiHash: "hash",
      botUsername: "StartupMottBot",
      target: "StartupMottBot",
      message: "hello",
      forceDocument: false,
      replyToLatestBotMessage: false,
      sessionPath: "./data/telegram-user-smoke.session",
      timeoutMs: 90_000,
      pollIntervalMs: 2_000,
      stableReplyMs: 4_000,
      waitForReply: false,
      expectReply: false,
      expectReplyContains: "received",
    });
  });

  it("evaluates expected reply and no-reply outcomes", () => {
    expect(
      evaluateTelegramUserSmokeStatus({
        waitForReply: true,
        expectReply: true,
        replyText: "attachment includes fixture-token",
        hasLastIncoming: true,
        expectReplyContains: "fixture-token",
      }),
    ).toEqual({ status: "passed", replyMatchedExpectation: true });
    expect(
      evaluateTelegramUserSmokeStatus({
        waitForReply: true,
        expectReply: true,
        replyText: "different text",
        hasLastIncoming: true,
        expectReplyContains: "fixture-token",
      }),
    ).toEqual({ status: "assertion_failed", replyMatchedExpectation: false });
    expect(
      evaluateTelegramUserSmokeStatus({
        waitForReply: true,
        expectReply: false,
        hasLastIncoming: false,
      }),
    ).toEqual({ status: "passed" });
    expect(
      evaluateTelegramUserSmokeStatus({
        waitForReply: true,
        expectReply: false,
        replyText: "unexpected bot response",
        hasLastIncoming: true,
      }),
    ).toEqual({ status: "unexpected_reply" });
  });

  it("identifies transient bot status messages", () => {
    expect(isTransientBotStatus(RUN_STATUS_TEXT.starting)).toBe(true);
    expect(isTransientBotStatus(RUN_STATUS_TEXT.resumingAfterRestart)).toBe(true);
    expect(isTransientBotStatus(RUN_STATUS_TEXT.unableToResumeAfterRestart)).toBe(true);
    expect(isTransientBotStatus("Working...")).toBe(true);
    expect(isTransientBotStatus("Resuming queued request after restart...")).toBe(true);
    expect(isTransientBotStatus("Unable to resume queued request after restart.")).toBe(true);
    expect(isTransientBotStatus(formatToolPreparingStatus("mottbot_health_snapshot"))).toBe(true);
    expect(isTransientBotStatus(formatToolRunningStatus("mottbot_health_snapshot"))).toBe(true);
    expect(
      isTransientBotStatus(formatToolCompletedStatus({ toolName: "mottbot_health_snapshot", isError: false })),
    ).toBe(true);
    expect(isTransientBotStatus(formatToolCompletedStatus({ toolName: "mottbot_shell", isError: true }))).toBe(true);
    expect(isTransientBotStatus("Health is ok.")).toBe(false);
  });
});
