import { isTransientRunStatus } from "../shared/run-status.js";

export type TelegramUserSmokeConfig = {
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
};

export type TelegramUserSmokeEnv = Record<string, string | undefined>;

const DEFAULT_MESSAGE = "Use your health snapshot tool and tell me the current status.";
const DEFAULT_SESSION_PATH = "./data/telegram-user-smoke.session";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_STABLE_REPLY_MS = 4_000;

export function normalizeBotUsername(value: string): string {
  const trimmed = value.trim().replace(/^@+/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(trimmed)) {
    throw new Error("MOTTBOT_LIVE_BOT_USERNAME must be a Telegram username such as StartupMottBot.");
  }
  return trimmed;
}

export function parsePositiveIntegerEnv(env: TelegramUserSmokeEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseBooleanEnv(env: TelegramUserSmokeEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(`${name} must be true or false.`);
}

export function buildTelegramUserSmokeConfig(params: {
  env: TelegramUserSmokeEnv;
  fallbackBotUsername: string;
}): TelegramUserSmokeConfig {
  const apiIdRaw = params.env.TELEGRAM_API_ID?.trim();
  const apiHash = params.env.TELEGRAM_API_HASH?.trim();
  if (!apiIdRaw) {
    throw new Error("Missing TELEGRAM_API_ID.");
  }
  if (!apiHash) {
    throw new Error("Missing TELEGRAM_API_HASH.");
  }
  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId < 1) {
    throw new Error("TELEGRAM_API_ID must be a positive integer.");
  }
  return {
    apiId,
    apiHash,
    botUsername: normalizeBotUsername(params.env.MOTTBOT_LIVE_BOT_USERNAME ?? params.fallbackBotUsername),
    target:
      params.env.MOTTBOT_USER_SMOKE_TARGET?.trim() ||
      normalizeBotUsername(params.env.MOTTBOT_LIVE_BOT_USERNAME ?? params.fallbackBotUsername),
    message: params.env.MOTTBOT_USER_SMOKE_MESSAGE?.trim() || DEFAULT_MESSAGE,
    ...(params.env.MOTTBOT_USER_SMOKE_FILE_PATH?.trim()
      ? { filePath: params.env.MOTTBOT_USER_SMOKE_FILE_PATH.trim() }
      : {}),
    forceDocument: parseBooleanEnv(params.env, "MOTTBOT_USER_SMOKE_FORCE_DOCUMENT", false),
    replyToLatestBotMessage: parseBooleanEnv(params.env, "MOTTBOT_USER_SMOKE_REPLY_TO_LATEST_BOT_MESSAGE", false),
    sessionPath: params.env.MOTTBOT_USER_SMOKE_SESSION_PATH?.trim() || DEFAULT_SESSION_PATH,
    timeoutMs: parsePositiveIntegerEnv(params.env, "MOTTBOT_USER_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    pollIntervalMs: parsePositiveIntegerEnv(
      params.env,
      "MOTTBOT_USER_SMOKE_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
    ),
    stableReplyMs: parsePositiveIntegerEnv(params.env, "MOTTBOT_USER_SMOKE_STABLE_REPLY_MS", DEFAULT_STABLE_REPLY_MS),
    waitForReply: parseBooleanEnv(params.env, "MOTTBOT_USER_SMOKE_WAIT_FOR_REPLY", true),
  };
}

export function isTransientBotStatus(text: string): boolean {
  return isTransientRunStatus(text);
}
