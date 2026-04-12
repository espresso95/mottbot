import { Bot, type Context } from "grammy";
import type { AppConfig } from "../app/config.js";
import type { Clock } from "../shared/clock.js";
import type { Logger } from "../shared/logger.js";
import type { AccessController } from "./acl.js";
import type { TelegramCommandRouter } from "./commands.js";
import { normalizeUpdate } from "./update-normalizer.js";
import type { RouteResolver } from "./route-resolver.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";

export class TelegramBotServer {
  private readonly bot: Bot<Context>;
  private botUsername?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly logger: Logger,
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
      const event = normalizeUpdate({
        ctx,
        botUsername: this.botUsername,
        clock: this.clock,
      });
      if (!event) {
        return;
      }
      const handled = await this.commands.maybeHandle(event);
      if (handled) {
        return;
      }
      const decision = this.access.evaluate(event);
      if (!decision.allow) {
        this.logger.debug({ reason: decision.reason, updateId: event.updateId }, "Telegram update rejected.");
        return;
      }
      const session = this.routes.resolve(event);
      await this.orchestrator.enqueueMessage({
        event,
        session,
      });
    });

    if (!this.config.telegram.polling) {
      throw new Error("Webhook mode is not implemented yet. Set telegram.polling=true.");
    }

    await this.bot.start();
    this.logger.info({ botUsername: this.botUsername }, "Telegram bot started.");
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
