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
  parseBooleanOption,
  parseTelegramUserSmokeOptions,
} from "../../scripts/smoke/telegram-user-smoke-helpers.js";

describe("telegram user smoke helpers", () => {
  it("normalizes bot usernames", () => {
    expect(normalizeBotUsername("@StartupMottBot")).toBe("StartupMottBot");
    expect(() => normalizeBotUsername("bad")).toThrow("Telegram username");
  });

  it("parses guarded CLI values", () => {
    expect(parseBooleanOption("wait", undefined, true)).toBe(true);
    expect(parseBooleanOption("wait", "false", true)).toBe(false);
    expect(parseBooleanOption("wait", "yes", false)).toBe(true);
    expect(() => parseBooleanOption("wait", "maybe", false)).toThrow("true or false");

    expect(
      parseTelegramUserSmokeOptions([
        "--api-id",
        "12345",
        "--api-hash=hash",
        "--message",
        "hello",
        "--no-wait-for-reply",
        "--expect-reply=false",
        "--expect-reply-contains",
        "received",
      ]),
    ).toMatchObject({
      apiId: 12345,
      apiHash: "hash",
      message: "hello",
      waitForReply: false,
      expectReply: false,
      expectReplyContains: "received",
    });
    expect(() => parseTelegramUserSmokeOptions(["--api-id", "0"])).toThrow("positive integer");
  });

  it("builds smoke config from CLI options", () => {
    expect(
      buildTelegramUserSmokeConfig({
        fallbackBotUsername: "StartupMottBot",
        options: {
          apiId: 12345,
          apiHash: "hash",
          message: "hello",
          waitForReply: false,
          expectReply: false,
          expectReplyContains: "received",
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
