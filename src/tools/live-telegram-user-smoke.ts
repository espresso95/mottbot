#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Logger, TelegramClient, sessions, type Api } from "telegram";
import { LogLevel } from "telegram/extensions/Logger.js";
import { loadConfig } from "../app/config.js";
import {
  buildTelegramUserSmokeConfig,
  isTransientBotStatus,
  type TelegramUserSmokeConfig,
} from "./telegram-user-smoke-helpers.js";

type SmokeReply = {
  messageId: number;
  text: string;
};

type SentSmokeMessage = {
  id: number;
};

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readSession(sessionPath: string): string {
  return fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath, "utf8").trim() : "";
}

function writeSession(sessionPath: string, value: string): void {
  if (!value.trim()) {
    return;
  }
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${value.trim()}\n`, { mode: 0o600 });
  fs.chmodSync(sessionPath, 0o600);
}

async function prompt(label: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(label);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function readCredential(params: {
  envName: string;
  promptLabel: string;
  allowPrompt: boolean;
}): Promise<string> {
  const fromEnv = process.env[params.envName]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (!params.allowPrompt) {
    throw new Error(`Missing ${params.envName}; run interactively or provide it in the environment.`);
  }
  return prompt(params.promptLabel);
}

async function startUserClient(config: TelegramUserSmokeConfig): Promise<TelegramClient> {
  const stringSession = new sessions.StringSession(
    process.env.TELEGRAM_USER_SESSION?.trim() || readSession(config.sessionPath),
  );
  const client = new TelegramClient(stringSession, config.apiId, config.apiHash, {
    baseLogger: new Logger(LogLevel.NONE),
    connectionRetries: 5,
  });
  const allowPrompt = process.stdin.isTTY && process.stdout.isTTY;
  await client.start({
    phoneNumber: () =>
      readCredential({
        envName: "TELEGRAM_PHONE_NUMBER",
        promptLabel: "Telegram phone number: ",
        allowPrompt,
      }),
    phoneCode: (isCodeViaApp) =>
      readCredential({
        envName: "TELEGRAM_LOGIN_CODE",
        promptLabel: isCodeViaApp ? "Telegram app login code: " : "Telegram SMS login code: ",
        allowPrompt,
      }),
    password: (hint) =>
      readCredential({
        envName: "TELEGRAM_2FA_PASSWORD",
        promptLabel: hint ? `Telegram 2FA password (${hint}): ` : "Telegram 2FA password: ",
        allowPrompt,
      }),
    onError: (error) => {
      throw error;
    },
  });
  writeSession(config.sessionPath, client.session.save() as unknown as string);
  return client;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(message: Api.Message): string {
  return typeof message.message === "string" ? message.message.trim() : "";
}

function entityId(entity: unknown): string | undefined {
  if (!entity || typeof entity !== "object" || !("id" in entity)) {
    return undefined;
  }
  const id = (entity as { id?: unknown }).id;
  return id === undefined || id === null ? undefined : String(id);
}

async function findLatestBotMessage(params: {
  client: TelegramClient;
  target: string;
  botUserId?: string;
}): Promise<number | undefined> {
  const messages = await params.client.getMessages(params.target, { limit: 25 });
  for (const message of messages) {
    const text = messageText(message);
    if (message.out || !text) {
      continue;
    }
    if (params.botUserId && String(message.senderId) !== params.botUserId) {
      continue;
    }
    return message.id;
  }
  return undefined;
}

async function sendSmokeMessage(params: {
  client: TelegramClient;
  config: TelegramUserSmokeConfig;
  replyTo?: number;
}): Promise<SentSmokeMessage> {
  if (!params.config.filePath) {
    return params.client.sendMessage(params.config.target, {
      message: params.config.message,
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });
  }
  if (!fs.existsSync(params.config.filePath)) {
    throw new Error(`MOTTBOT_USER_SMOKE_FILE_PATH does not exist: ${params.config.filePath}`);
  }
  const sendFileParams: Parameters<TelegramClient["sendFile"]>[1] = {
    file: params.config.filePath,
    caption: params.config.message,
    ...(params.replyTo ? { replyTo: params.replyTo } : {}),
  };
  if (params.config.forceDocument) {
    (sendFileParams as { forceDocument?: boolean }).forceDocument = true;
  }
  return params.client.sendFile(params.config.target, sendFileParams);
}

async function waitForReply(params: {
  client: TelegramClient;
  botUserId?: string;
  target: string;
  sentMessageId: number;
  timeoutMs: number;
  pollIntervalMs: number;
  stableReplyMs: number;
}): Promise<{ reply?: SmokeReply; lastIncoming?: SmokeReply }> {
  const startedAt = Date.now();
  let lastIncoming: SmokeReply | undefined;
  let candidate: SmokeReply | undefined;
  let candidateSince = 0;
  while (Date.now() - startedAt <= params.timeoutMs) {
    const now = Date.now();
    const messages = await params.client.getMessages(params.target, {
      limit: 12,
      minId: params.sentMessageId,
    });
    let newestCandidate: SmokeReply | undefined;
    for (const message of [...messages].sort((left, right) => left.id - right.id)) {
      const text = messageText(message);
      if (message.out || message.id <= params.sentMessageId || !text) {
        continue;
      }
      if (params.botUserId && String(message.senderId) !== params.botUserId) {
        continue;
      }
      lastIncoming = {
        messageId: message.id,
        text,
      };
      if (!isTransientBotStatus(text)) {
        newestCandidate = lastIncoming;
      }
    }

    if (!newestCandidate) {
      candidate = undefined;
      candidateSince = 0;
    } else if (
      candidate &&
      candidate.messageId === newestCandidate.messageId &&
      candidate.text === newestCandidate.text
    ) {
      if (now - candidateSince >= params.stableReplyMs) {
        return { reply: candidate, lastIncoming };
      }
    } else {
      candidate = newestCandidate;
      candidateSince = now;
    }

    await sleep(params.pollIntervalMs);
  }
  return { lastIncoming };
}

async function main(): Promise<void> {
  if (process.env.MOTTBOT_USER_SMOKE_ENABLED !== "true") {
    printJson({
      status: "skipped",
      reason: "Set MOTTBOT_USER_SMOKE_ENABLED=true to send a Telegram user-account smoke message.",
    });
    return;
  }

  const appConfig = loadConfig();
  const liveConfig = buildTelegramUserSmokeConfig({
    env: process.env,
    fallbackBotUsername: process.env.MOTTBOT_LIVE_BOT_USERNAME ?? "StartupMottBot",
  });

  const client = await startUserClient(liveConfig);
  try {
    const botUserId = entityId(await client.getEntity(liveConfig.botUsername));
    const replyTo = liveConfig.replyToLatestBotMessage
      ? await findLatestBotMessage({
          client,
          target: liveConfig.target,
          botUserId,
        })
      : undefined;
    const sent = await sendSmokeMessage({
      client,
      config: liveConfig,
      replyTo,
    });
    const response = liveConfig.waitForReply
      ? await waitForReply({
          client,
          botUserId,
          target: liveConfig.target,
          sentMessageId: sent.id,
          timeoutMs: liveConfig.timeoutMs,
          pollIntervalMs: liveConfig.pollIntervalMs,
          stableReplyMs: liveConfig.stableReplyMs,
        })
      : {};

    printJson({
      status: response.reply ? "passed" : liveConfig.waitForReply ? "timeout" : "sent",
      botUsername: liveConfig.botUsername,
      target: liveConfig.target,
      sentMessageId: sent.id,
      ...(replyTo ? { replyToMessageId: replyTo } : {}),
      ...(liveConfig.filePath ? { filePath: path.resolve(liveConfig.filePath) } : {}),
      ...(response.reply ? { reply: response.reply } : {}),
      ...(response.lastIncoming && !response.reply ? { lastIncoming: response.lastIncoming } : {}),
      waitForReply: liveConfig.waitForReply,
      timeoutMs: liveConfig.timeoutMs,
      stableReplyMs: liveConfig.stableReplyMs,
      sessionPath: path.resolve(liveConfig.sessionPath),
      sqlitePath: appConfig.storage.sqlitePath,
    });

    if (liveConfig.waitForReply && !response.reply) {
      process.exitCode = 1;
    }
  } finally {
    await client.disconnect();
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  printJson({ status: "failed", error: message });
  process.exitCode = 1;
}
