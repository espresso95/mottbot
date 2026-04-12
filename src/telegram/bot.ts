import { createServer, type Server } from "node:http";
import { Bot, type Context, webhookCallback } from "grammy";
import type { AppConfig } from "../app/config.js";
import type { Clock } from "../shared/clock.js";
import type { Logger } from "../shared/logger.js";
import type { AccessController } from "./acl.js";
import type { TelegramCommandRouter } from "./commands.js";
import { normalizeUpdate } from "./update-normalizer.js";
import type { RouteResolver } from "./route-resolver.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";
import type { TelegramUpdateStore } from "./update-store.js";

export class TelegramBotServer {
  private readonly bot: Bot<Context>;
  private botUsername?: string;
  private webhookServer?: Server;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly updates: TelegramUpdateStore,
    private readonly access: AccessController,
    private readonly commands: TelegramCommandRouter,
    private readonly routes: RouteResolver,
    private readonly orchestrator: RunOrchestrator,
  ) {
    this.bot = new Bot<Context>(config.telegram.botToken);
  }

  get api() {
    return this.bot.api;
  }

  async start(): Promise<void> {
    const me = await this.bot.api.getMe();
    this.botUsername = me.username;

    this.bot.catch(async (error) => {
      this.logger.error({ error }, "Telegram bot error.");
    });

    this.bot.on("message", async (ctx) => {
      await this.handleMessage(ctx);
    });

    if (this.config.telegram.polling) {
      await this.bot.api.deleteWebhook({
        drop_pending_updates: false,
      });
      await this.bot.start();
      this.logger.info({ botUsername: this.botUsername }, "Telegram bot started.");
      return;
    }

    await this.startWebhook();
    this.logger.info({ botUsername: this.botUsername }, "Telegram bot started in webhook mode.");
  }

  async stop(): Promise<void> {
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
      this.webhookServer?.listen(
        this.config.telegram.webhook.port,
        this.config.telegram.webhook.host,
        () => resolve(),
      );
    });
    await this.bot.api.setWebhook(new URL(path, publicUrl).toString(), {
      secret_token: secretToken,
      allowed_updates: ["message"],
    });
  }
}
