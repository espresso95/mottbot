import { isTransientRunStatus } from "../../src/shared/run-status.js";
import {
  booleanFlag,
  parseBooleanValue,
  parseCliArgs,
  positiveIntegerFlag,
  stringFlag,
  type ParsedCliArgs,
} from "./cli-args.js";

/** Parsed configuration for a user-account Telegram smoke test. */
export type TelegramUserSmokeConfig = {
  dryRun: boolean;
  apiId: number;
  apiHash: string;
  botUsername: string;
  target: string;
  message: string;
  filePath?: string;
  forceDocument: boolean;
  replyToLatestBotMessage: boolean;
  sessionPath: string;
  timeoutMs: number;
  pollIntervalMs: number;
  stableReplyMs: number;
  waitForReply: boolean;
  expectReply: boolean;
  expectReplyContains?: string;
  phoneNumber?: string;
  loginCode?: string;
  twoFactorPassword?: string;
  userSession?: string;
};

/** CLI options consumed by Telegram user smoke helpers. */
export type TelegramUserSmokeOptions = {
  dryRun?: boolean;
  apiId?: number;
  apiHash?: string;
  botUsername?: string;
  target?: string;
  message?: string;
  filePath?: string;
  forceDocument?: boolean;
  replyToLatestBotMessage?: boolean;
  sessionPath?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  stableReplyMs?: number;
  waitForReply?: boolean;
  expectReply?: boolean;
  expectReplyContains?: string;
  phoneNumber?: string;
  loginCode?: string;
  twoFactorPassword?: string;
  userSession?: string;
};

/** Outcome status for a user-account Telegram smoke interaction. */
export type TelegramUserSmokeStatus = "sent" | "passed" | "assertion_failed" | "timeout" | "unexpected_reply";

const DEFAULT_MESSAGE = "Use your health snapshot tool and tell me the current status.";
const DEFAULT_SESSION_PATH = "./data/telegram-user-smoke.session";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STABLE_REPLY_MS = 4_000;

/** Normalizes and validates a Telegram bot username without a leading at sign. */
export function normalizeBotUsername(value: string): string {
  const trimmed = value.trim().replace(/^@+/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(trimmed)) {
    throw new Error("--bot-username must be a Telegram username such as StartupMottBot.");
  }
  return trimmed;
}

/** Parses common boolean flag strings with a fallback. */
export function parseBooleanOption(name: string, value: string | undefined, fallback: boolean): boolean {
  return parseBooleanValue(name, value, fallback);
}

/** Builds Telegram user smoke options from CLI flags. */
export function parseTelegramUserSmokeOptions(argv: readonly string[]): TelegramUserSmokeOptions {
  const args = parseCliArgs(argv);
  return telegramUserSmokeOptionsFromArgs(args);
}

/** Builds Telegram user smoke options from parsed CLI args. */
export function telegramUserSmokeOptionsFromArgs(args: ParsedCliArgs): TelegramUserSmokeOptions {
  return {
    dryRun: booleanFlag(args, "dry-run", false),
    ...(positiveIntegerFlag(args, "api-id") ? { apiId: positiveIntegerFlag(args, "api-id") } : {}),
    ...(stringFlag(args, "api-hash") ? { apiHash: stringFlag(args, "api-hash") } : {}),
    ...(stringFlag(args, "bot-username") ? { botUsername: stringFlag(args, "bot-username") } : {}),
    ...(stringFlag(args, "target") ? { target: stringFlag(args, "target") } : {}),
    ...(stringFlag(args, "message") ? { message: stringFlag(args, "message") } : {}),
    ...(stringFlag(args, "file-path") ? { filePath: stringFlag(args, "file-path") } : {}),
    forceDocument: booleanFlag(args, "force-document", false),
    replyToLatestBotMessage: booleanFlag(args, "reply-to-latest-bot-message", false),
    ...(stringFlag(args, "session-path") ? { sessionPath: stringFlag(args, "session-path") } : {}),
    timeoutMs: positiveIntegerFlag(args, "timeout-ms", DEFAULT_TIMEOUT_MS),
    pollIntervalMs: positiveIntegerFlag(args, "poll-interval-ms", DEFAULT_POLL_INTERVAL_MS),
    stableReplyMs: positiveIntegerFlag(args, "stable-reply-ms", DEFAULT_STABLE_REPLY_MS),
    waitForReply: booleanFlag(args, "wait-for-reply", true),
    expectReply: booleanFlag(args, "expect-reply", true),
    ...(stringFlag(args, "expect-reply-contains")
      ? { expectReplyContains: stringFlag(args, "expect-reply-contains") }
      : {}),
    ...(stringFlag(args, "phone-number") ? { phoneNumber: stringFlag(args, "phone-number") } : {}),
    ...(stringFlag(args, "login-code") ? { loginCode: stringFlag(args, "login-code") } : {}),
    ...(stringFlag(args, "two-factor-password") ? { twoFactorPassword: stringFlag(args, "two-factor-password") } : {}),
    ...(stringFlag(args, "user-session") ? { userSession: stringFlag(args, "user-session") } : {}),
  };
}

/** Builds validated Telegram user smoke configuration from CLI options. */
export function buildTelegramUserSmokeConfig(params: {
  options: TelegramUserSmokeOptions;
  fallbackBotUsername: string;
}): TelegramUserSmokeConfig {
  const apiId = params.options.apiId;
  const apiHash = params.options.apiHash?.trim();
  if (!apiId) {
    throw new Error("Missing --api-id.");
  }
  if (!apiHash) {
    throw new Error("Missing --api-hash.");
  }
  const botUsername = normalizeBotUsername(params.options.botUsername ?? params.fallbackBotUsername);
  return {
    dryRun: params.options.dryRun ?? false,
    apiId,
    apiHash,
    botUsername,
    target: params.options.target?.trim() || botUsername,
    message: params.options.message?.trim() || DEFAULT_MESSAGE,
    ...(params.options.filePath?.trim() ? { filePath: params.options.filePath.trim() } : {}),
    forceDocument: params.options.forceDocument ?? false,
    replyToLatestBotMessage: params.options.replyToLatestBotMessage ?? false,
    sessionPath: params.options.sessionPath?.trim() || DEFAULT_SESSION_PATH,
    timeoutMs: params.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pollIntervalMs: params.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    stableReplyMs: params.options.stableReplyMs ?? DEFAULT_STABLE_REPLY_MS,
    waitForReply: params.options.waitForReply ?? true,
    expectReply: params.options.expectReply ?? true,
    ...(params.options.expectReplyContains?.trim()
      ? { expectReplyContains: params.options.expectReplyContains.trim() }
      : {}),
    ...(params.options.phoneNumber?.trim() ? { phoneNumber: params.options.phoneNumber.trim() } : {}),
    ...(params.options.loginCode?.trim() ? { loginCode: params.options.loginCode.trim() } : {}),
    ...(params.options.twoFactorPassword?.trim() ? { twoFactorPassword: params.options.twoFactorPassword.trim() } : {}),
    ...(params.options.userSession?.trim() ? { userSession: params.options.userSession.trim() } : {}),
  };
}

/** Evaluates whether a smoke interaction satisfied the configured reply expectations. */
export function evaluateTelegramUserSmokeStatus(params: {
  waitForReply: boolean;
  expectReply: boolean;
  replyText?: string;
  hasLastIncoming: boolean;
  expectReplyContains?: string;
}): { status: TelegramUserSmokeStatus; replyMatchedExpectation?: boolean } {
  const hasReply = typeof params.replyText === "string";
  const replyMatchedExpectation = params.expectReplyContains
    ? hasReply && params.replyText!.includes(params.expectReplyContains)
    : undefined;
  const status: TelegramUserSmokeStatus = !params.waitForReply
    ? "sent"
    : params.expectReply
      ? hasReply
        ? replyMatchedExpectation === false
          ? "assertion_failed"
          : "passed"
        : "timeout"
      : params.hasLastIncoming
        ? "unexpected_reply"
        : "passed";
  return {
    status,
    ...(replyMatchedExpectation !== undefined ? { replyMatchedExpectation } : {}),
  };
}

/** Detects bot status messages that should not count as stable smoke-test replies. */
export function isTransientBotStatus(text: string): boolean {
  return isTransientRunStatus(text);
}
