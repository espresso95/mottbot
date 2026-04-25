import { createServer, type Server } from "node:http";
import { Bot, type Context, webhookCallback } from "grammy";
import type { AppConfig } from "../app/config.js";
import type { Clock } from "../shared/clock.js";
import type { Logger } from "../shared/logger.js";
import type { AccessController } from "./acl.js";
import type { TelegramCommandRouter } from "./commands.js";
import { normalizeCallbackQuery, normalizeUpdate } from "./update-normalizer.js";
import type { RouteResolver } from "./route-resolver.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";
import type { TelegramUpdateStore } from "./update-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { TelegramMessageStore } from "./message-store.js";
import { splitTelegramText } from "./formatting.js";
import { validateInboundSafety } from "./safety.js";
import {
  formatReactionNotification,
  normalizeReactionUpdate,
  type NormalizedReactionEvent,
  type TelegramReactionService,
} from "./reactions.js";

const POLLING_CONFLICT_RETRY_MS = 30_000;

const TELEGRAM_COMMAND_MENU = [
  { command: "help", description: "Show available commands" },
  { command: "commands", description: "Show available commands" },
  { command: "status", description: "Show session status" },
  { command: "health", description: "Show runtime health" },
  { command: "usage", description: "Show local run usage" },
  { command: "agent", description: "Inspect or change this session agent" },
  { command: "model", description: "Change this session model" },
  { command: "profile", description: "List or select auth profile" },
  { command: "fast", description: "Toggle priority service tier" },
  { command: "new", description: "Clear this session transcript" },
  { command: "reset", description: "Clear this session transcript" },
  { command: "stop", description: "Cancel the active run" },
  { command: "files", description: "Inspect uploaded file metadata" },
  { command: "bind", description: "Keep replies always on here" },
  { command: "unbind", description: "Restore default reply behavior" },
  { command: "remember", description: "Store memory for this session" },
  { command: "memory", description: "List or manage memory" },
  { command: "forget", description: "Remove memory" },
  { command: "tool", description: "Manage tools and approvals" },
  { command: "tools", description: "Show tool command help" },
  { command: "auth", description: "Manage auth profiles" },
  { command: "runs", description: "List recent runs" },
  { command: "debug", description: "Inspect diagnostics" },
  { command: "github", description: "Inspect GitHub state" },
  { command: "gh", description: "Inspect GitHub state" },
  { command: "users", description: "Manage users and chat policy" },
] as const;

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasTelegramErrorCode(error: unknown, code: number): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybe = error as { error_code?: unknown; message?: unknown; description?: unknown };
  if (maybe.error_code === code) {
    return true;
  }
  const text = `${stringField(maybe.message)}\n${stringField(maybe.description)}`;
  return text.includes(`${code}:`);
}

/** Owns grammY polling or webhook ingress and routes normalized updates into application services. */
export class TelegramBotServer {
  private readonly bot: Bot<Context>;
  private botUsername?: string;
  private webhookServer?: Server;
  private stopping = false;
  private retryTimeout?: NodeJS.Timeout;
  private retryResolve?: () => void;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly updates: TelegramUpdateStore,
    private readonly access: AccessController,
    private readonly commands: TelegramCommandRouter,
    private readonly routes: RouteResolver,
    private readonly orchestrator: RunOrchestrator,
    private readonly reactions?: TelegramReactionService,
    private readonly transcripts?: TranscriptStore,
    private readonly messages?: TelegramMessageStore,
    bot?: Bot<Context>,
  ) {
    this.bot = bot ?? new Bot<Context>(config.telegram.botToken);
  }

  get api() {
    return this.bot.api;
  }

  async start(): Promise<void> {
    this.stopping = false;
    const me = await this.bot.api.getMe();
    this.botUsername = me.username;
    await this.registerCommandMenu();

    this.bot.catch(async (error) => {
      this.logger.error({ error }, "Telegram bot error.");
    });

    this.bot.on("message", async (ctx) => {
      await this.handleMessage(ctx);
    });
    this.bot.on("callback_query:data", async (ctx) => {
      await this.handleCallbackQuery(ctx);
    });
    if (this.acceptsReactionUpdates()) {
      this.bot.on("message_reaction", async (ctx) => {
        await this.handleReaction(ctx);
      });
    }

    if (this.config.telegram.polling) {
      await this.bot.api.deleteWebhook({
        drop_pending_updates: false,
      });
      this.logger.info({ botUsername: this.botUsername }, "Telegram bot starting in polling mode.");
      await this.startPolling();
      return;
    }

    await this.startWebhook();
    this.logger.info({ botUsername: this.botUsername }, "Telegram bot started in webhook mode.");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wakePollingRetry();
    if (this.webhookServer) {
      await new Promise<void>((resolve, reject) => {
        this.webhookServer?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.webhookServer = undefined;
      return;
    }
    await this.bot.stop();
  }

  private async registerCommandMenu(): Promise<void> {
    try {
      await this.bot.api.setMyCommands([...TELEGRAM_COMMAND_MENU]);
    } catch (error) {
      this.logger.warn({ error }, "Failed to register Telegram command menu.");
    }
  }

  private async startPolling(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.bot.start();
        return;
      } catch (error) {
        if (this.stopping) {
          return;
        }
        if (!hasTelegramErrorCode(error, 409)) {
          throw error;
        }
        this.logger.warn(
          { retryMs: POLLING_CONFLICT_RETRY_MS },
          "Telegram polling conflict detected. Another getUpdates consumer is using this bot token; retrying.",
        );
        await this.waitBeforePollingRetry(POLLING_CONFLICT_RETRY_MS);
      }
    }
  }

  private waitBeforePollingRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryResolve = resolve;
      this.retryTimeout = setTimeout(() => {
        this.retryTimeout = undefined;
        this.retryResolve = undefined;
        resolve();
      }, ms);
    });
  }

  private wakePollingRetry(): void {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = undefined;
    }
    const resolve = this.retryResolve;
    this.retryResolve = undefined;
    resolve?.();
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const event = normalizeUpdate({
      ctx,
      botUsername: this.botUsername,
      clock: this.clock,
    });
    if (!event) {
      return;
    }
    const begin = this.updates.begin(event.updateId);
    if (!begin.accepted) {
      this.logger.debug({ reason: begin.reason, updateId: event.updateId }, "Telegram update ignored.");
      return;
    }
    let processed = false;
    try {
      const safety = validateInboundSafety(this.config, event);
      if (!safety.allow) {
        processed = true;
        try {
          await this.sendReply(event, safety.message);
        } catch (error) {
          this.logger.warn(
            { error, reason: safety.reason, updateId: event.updateId },
            "Failed to send safety-limit rejection reply.",
          );
        }
        this.logger.debug(
          { reason: safety.reason, updateId: event.updateId },
          "Telegram update rejected by safety limits.",
        );
        return;
      }
      const handled = await this.commands.maybeHandle(event);
      if (handled) {
        processed = true;
        return;
      }
      const decision = this.access.evaluate(event);
      if (!decision.allow) {
        this.logger.debug({ reason: decision.reason, updateId: event.updateId }, "Telegram update rejected.");
        processed = true;
        return;
      }
      const session = this.routes.resolve(event);
      await this.trySendAckReaction(event);
      await this.orchestrator.enqueueMessage({
        event,
        session,
      });
      processed = true;
    } finally {
      if (processed) {
        this.updates.markProcessed({
          updateId: event.updateId,
          chatId: event.chatId,
          messageId: event.messageId,
        });
      } else {
        this.updates.release(event.updateId);
      }
    }
  }

  private async handleReaction(ctx: Context): Promise<void> {
    const event = normalizeReactionUpdate({
      ctx,
      clock: this.clock,
    });
    if (!event) {
      return;
    }
    const begin = this.updates.begin(event.updateId);
    if (!begin.accepted) {
      this.logger.debug({ reason: begin.reason, updateId: event.updateId }, "Telegram reaction update ignored.");
      return;
    }
    let processed = false;
    try {
      if (!this.shouldRecordReaction(event)) {
        processed = true;
        return;
      }
      const session = this.routes.resolve({
        updateId: event.updateId,
        chatId: event.chatId,
        chatType: event.chatType,
        messageId: event.messageId,
        ...(event.fromUserId ? { fromUserId: event.fromUserId } : {}),
        ...(event.fromUsername ? { fromUsername: event.fromUsername } : {}),
        entities: [],
        attachments: [],
        mentionsBot: false,
        isCommand: false,
        arrivedAt: event.arrivedAt,
      });
      this.transcripts?.add({
        sessionKey: session.sessionKey,
        role: "system",
        telegramMessageId: event.messageId,
        contentText: formatReactionNotification(event),
        contentJson: JSON.stringify({ telegramReaction: event }),
      });
      processed = true;
    } finally {
      if (processed) {
        this.updates.markProcessed({
          updateId: event.updateId,
          chatId: event.chatId,
          messageId: event.messageId,
        });
      } else {
        this.updates.release(event.updateId);
      }
    }
  }

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const event = normalizeCallbackQuery({
      ctx,
      clock: this.clock,
    });
    if (!event) {
      return;
    }
    const begin = this.updates.begin(event.updateId);
    if (!begin.accepted) {
      this.logger.debug({ reason: begin.reason, updateId: event.updateId }, "Telegram callback update ignored.");
      return;
    }
    let processed = false;
    try {
      const handled = await this.commands.maybeHandleCallback(event);
      if (!handled) {
        await this.bot.api.answerCallbackQuery(event.callbackQueryId, {
          text: "Unsupported button.",
          show_alert: true,
        });
      }
      processed = true;
    } finally {
      if (processed) {
        this.updates.markProcessed({
          updateId: event.updateId,
          chatId: event.chatId,
          messageId: event.messageId,
        });
      } else {
        this.updates.release(event.updateId);
      }
    }
  }

  private acceptsReactionUpdates(): boolean {
    return (
      this.config.telegram.reactions.enabled &&
      this.config.telegram.reactions.notifications !== "off" &&
      Boolean(this.transcripts && this.messages)
    );
  }

  private shouldRecordReaction(event: NormalizedReactionEvent): boolean {
    if (!this.acceptsReactionUpdates()) {
      return false;
    }
    if (event.addedEmojis.length === 0 && event.removedEmojis.length === 0) {
      return false;
    }
    if (this.config.telegram.allowedChatIds.length > 0 && !this.config.telegram.allowedChatIds.includes(event.chatId)) {
      return false;
    }
    if (this.config.telegram.reactions.notifications === "all") {
      return true;
    }
    return Boolean(
      this.messages?.hasMessageInChat({
        chatId: event.chatId,
        telegramMessageId: event.messageId,
      }),
    );
  }

  private async trySendAckReaction(event: { chatId: string; messageId: number }): Promise<void> {
    const ackEmoji = this.config.telegram.reactions.ackEmoji.trim();
    if (!this.config.telegram.reactions.enabled || !ackEmoji || !this.reactions) {
      return;
    }
    try {
      await this.reactions.setEmojiReaction({
        chatId: event.chatId,
        messageId: event.messageId,
        emoji: ackEmoji,
      });
    } catch (error) {
      this.logger.warn({ error }, "Failed to send Telegram ack reaction.");
    }
  }

  private async sendReply(
    event: {
      chatId: string;
      threadId?: number;
      messageId: number;
    },
    text: string,
  ): Promise<void> {
    for (const chunk of splitTelegramText(text)) {
      await this.bot.api.sendMessage(event.chatId, chunk, {
        ...(typeof event.threadId === "number" ? { message_thread_id: event.threadId } : {}),
        reply_parameters: { message_id: event.messageId },
      });
    }
  }

  private async startWebhook(): Promise<void> {
    const publicUrl = this.config.telegram.webhook.publicUrl?.trim();
    if (!publicUrl) {
      throw new Error("Missing telegram.webhook.publicUrl for webhook mode.");
    }
    const path = this.config.telegram.webhook.path;
    const secretToken = this.config.telegram.webhook.secretToken;
    const callback = webhookCallback(this.bot, "http", { secretToken });
    this.webhookServer = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method !== "POST" || requestUrl.pathname !== path) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      void callback(req, res).catch((error) => {
        this.logger.error({ error }, "Telegram webhook request failed.");
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.webhookServer?.once("error", reject);
      this.webhookServer?.listen(this.config.telegram.webhook.port, this.config.telegram.webhook.host, () => resolve());
    });
    await this.bot.api.setWebhook(new URL(path, publicUrl).toString(), {
      secret_token: secretToken,
      allowed_updates: this.acceptsReactionUpdates()
        ? ["message", "message_reaction", "callback_query"]
        : ["message", "callback_query"],
    });
  }
}
