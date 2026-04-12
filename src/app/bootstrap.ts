import { loadConfig } from "./config.js";
import { systemClock } from "../shared/clock.js";
import { SecretBox } from "../shared/crypto.js";
import { createLogger } from "../shared/logger.js";
import { DatabaseClient } from "../db/client.js";
import { migrateDatabase } from "../db/migrate.js";
import { AuthProfileStore } from "../codex/auth-store.js";
import { importCodexCliAuthProfile } from "../codex/cli-auth-import.js";
import { CodexTokenResolver } from "../codex/token-resolver.js";
import { CodexTransport } from "../codex/transport.js";
import { SessionStore } from "../sessions/session-store.js";
import { TranscriptStore } from "../sessions/transcript-store.js";
import { SessionQueue } from "../sessions/queue.js";
import { RunStore } from "../runs/run-store.js";
import { TelegramOutbox } from "../telegram/outbox.js";
import { AccessController } from "../telegram/acl.js";
import { RouteResolver } from "../telegram/route-resolver.js";
import { RunOrchestrator } from "../runs/run-orchestrator.js";
import { TelegramCommandRouter } from "../telegram/commands.js";
import { TelegramBotServer } from "../telegram/bot.js";

export async function bootstrapApplication() {
  const config = loadConfig();
  const logger = createLogger(config.logging.level);
  const database = new DatabaseClient(config.storage.sqlitePath);
  migrateDatabase(database);
  const secretBox = new SecretBox(config.security.masterKey);
  const authProfiles = new AuthProfileStore(database, systemClock, secretBox);
  if (config.auth.preferCliImport) {
    importCodexCliAuthProfile({
      store: authProfiles,
      profileId: config.auth.defaultProfile,
    });
  }

  const sessionStore = new SessionStore(database, systemClock);
  const transcriptStore = new TranscriptStore(database, systemClock);
  const queue = new SessionQueue();
  const runStore = new RunStore(database, systemClock);
  const tokenResolver = new CodexTokenResolver(authProfiles, logger);
  const transport = new CodexTransport(database, logger);

  const provisionalBot = new TelegramBotServer(
    config,
    systemClock,
    logger,
    new AccessController(config, sessionStore),
    {} as never,
    new RouteResolver(config, sessionStore),
    {} as never,
  );

  const outbox = new TelegramOutbox(
    provisionalBot.api,
    database,
    systemClock,
    logger,
    config.behavior.editThrottleMs,
  );
  const routeResolver = new RouteResolver(config, sessionStore);
  const orchestrator = new RunOrchestrator(
    config,
    queue,
    sessionStore,
    transcriptStore,
    runStore,
    tokenResolver,
    transport,
    outbox,
    logger,
  );
  const commands = new TelegramCommandRouter(
    provisionalBot.api,
    config,
    routeResolver,
    sessionStore,
    transcriptStore,
    authProfiles,
    tokenResolver,
    orchestrator,
  );
  const bot = new TelegramBotServer(
    config,
    systemClock,
    logger,
    new AccessController(config, sessionStore),
    commands,
    routeResolver,
    orchestrator,
  );

  return {
    config,
    logger,
    database,
    authProfiles,
    tokenResolver,
    bot,
    async start() {
      await bot.start();
    },
    async stop() {
      await bot.stop();
      database.close();
    },
  };
}
