import { loadConfig } from "./config.js";
import { systemClock } from "../shared/clock.js";
import { SecretBox } from "../shared/crypto.js";
import { createLogger } from "../shared/logger.js";
import { DatabaseClient } from "../db/client.js";
import { migrateDatabase } from "../db/migrate.js";
import { HealthReporter } from "./health.js";
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
import { RunQueueStore } from "../runs/run-queue-store.js";
import { TelegramCommandRouter } from "../telegram/commands.js";
import { TelegramBotServer } from "../telegram/bot.js";
import { TelegramUpdateStore } from "../telegram/update-store.js";
import { TelegramMessageStore } from "../telegram/message-store.js";
import { TelegramAttachmentIngestor } from "../telegram/attachments.js";
import { TelegramReactionService } from "../telegram/reactions.js";
import { DashboardServer } from "./dashboard.js";
import { createRuntimeToolRegistry } from "../tools/registry.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolApprovalStore } from "../tools/approval.js";
import { scheduleServiceRestart } from "../tools/process-control.js";
import { createToolPolicyEngine } from "../tools/policy.js";
import { MemoryStore } from "../sessions/memory-store.js";
import { AttachmentRecordStore } from "../sessions/attachment-store.js";
import { ApplicationInstanceLease } from "./instance-lease.js";
import { codexModelCapabilities } from "../models/provider.js";
import { OperatorDiagnostics } from "./diagnostics.js";
import { createOperatorDiagnosticToolHandlers } from "../tools/operator-diagnostic-handlers.js";
import { createTelegramReactionToolHandlers } from "../tools/telegram-reaction-handlers.js";
import { createTelegramSendToolHandlers } from "../tools/telegram-send-handlers.js";
import { createRepositoryToolHandlers } from "../tools/repository-handlers.js";
import { createLocalWriteToolHandlers } from "../tools/local-write-handlers.js";
import { createGithubToolHandlers } from "../tools/github-handlers.js";
import { GithubCliReadService } from "../tools/github-read.js";

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
  const runQueueStore = new RunQueueStore(database, systemClock);
  const memoryStore = new MemoryStore(database, systemClock);
  const attachmentRecordStore = new AttachmentRecordStore(database, systemClock);
  const toolApprovalStore = new ToolApprovalStore(database, systemClock);
  const tokenResolver = new CodexTokenResolver(authProfiles, logger);
  const transport = new CodexTransport(database, logger);
  const updateStore = new TelegramUpdateStore(database, systemClock);
  const messageStore = new TelegramMessageStore(database, systemClock);
  const health = new HealthReporter(config, database, authProfiles, systemClock);
  const diagnostics = new OperatorDiagnostics(config, database, systemClock);
  const github = new GithubCliReadService(config.tools.github);
  const instanceLease = new ApplicationInstanceLease(database, systemClock, logger, {
    leaseName: "bot",
    enabled: config.runtime.instanceLeaseEnabled,
    ttlMs: config.runtime.instanceLeaseTtlMs,
    refreshMs: config.runtime.instanceLeaseRefreshMs,
  });
  const routeResolver = new RouteResolver(config, sessionStore);
  const provisionalBot = new TelegramBotServer(
    config,
    systemClock,
    logger,
    updateStore,
    new AccessController(config, sessionStore, messageStore),
    {} as never,
    routeResolver,
    {} as never,
  );
  const reactions = new TelegramReactionService(provisionalBot.api);
  const toolRegistry = createRuntimeToolRegistry({
    enableSideEffectTools: config.tools.enableSideEffectTools,
  });
  const toolPolicy = createToolPolicyEngine({
    definitions: toolRegistry.listEnabled(),
    overrides: config.tools.policies,
  });
  const dashboard = new DashboardServer(config, logger, health, authProfiles, {
    diagnostics,
    toolRegistry,
    toolApprovals: toolApprovalStore,
    memories: memoryStore,
    restartService: ({ reason, delayMs }) =>
      scheduleServiceRestart({
        reason,
        delayMs,
      }),
  });
  const toolExecutor = new ToolExecutor(toolRegistry, {
    clock: systemClock,
    health,
    handlers: {
      ...createOperatorDiagnosticToolHandlers(diagnostics),
      ...createTelegramReactionToolHandlers(reactions),
      ...createTelegramSendToolHandlers(provisionalBot.api, config.tools.telegramSend),
      ...createRepositoryToolHandlers(config.tools.repository),
      ...createLocalWriteToolHandlers(config.tools.localWrite),
      ...createGithubToolHandlers(github),
    },
    adminUserIds: config.telegram.adminUserIds,
    approvals: toolApprovalStore,
    policy: toolPolicy,
    defaultRestartDelayMs: config.tools.restartDelayMs,
    restartService: ({ reason, delayMs }) =>
      scheduleServiceRestart({
        reason,
        delayMs,
      }),
  });

  const outbox = new TelegramOutbox(
    provisionalBot.api,
    database,
    systemClock,
    logger,
    config.behavior.editThrottleMs,
    messageStore,
  );
  const attachmentIngestor = new TelegramAttachmentIngestor(provisionalBot.api, config);
  const recoveredRuns = runStore.recoverInterruptedRuns();
  runQueueStore.failRuns(
    recoveredRuns.map((run) => run.runId),
    "Recovered as failed after process restart.",
  );
  const recoveredOutboxes = outbox.recoverInterruptedRuns({
    runs: recoveredRuns.map((run) => ({
      runId: run.runId,
      sessionKey: run.sessionKey,
    })),
  });
  for (const recovered of recoveredOutboxes) {
    if (!recovered.partialText || transcriptStore.hasRunMessage(recovered.runId, "assistant")) {
      continue;
    }
    transcriptStore.add({
      sessionKey: recovered.sessionKey,
      runId: recovered.runId,
      role: "assistant",
      contentText: `[Recovered partial assistant output after restart]\n${recovered.partialText}`,
    });
  }
  const orchestrator = new RunOrchestrator(
    config,
    queue,
    sessionStore,
    transcriptStore,
    runStore,
    tokenResolver,
    transport,
    outbox,
    systemClock,
    logger,
    attachmentIngestor,
    runQueueStore,
    toolRegistry,
    toolExecutor,
    memoryStore,
    codexModelCapabilities,
    reactions,
    attachmentRecordStore,
    toolPolicy,
  );
  orchestrator.recoverQueuedRuns();
  const commands = new TelegramCommandRouter(
    provisionalBot.api,
    config,
    routeResolver,
    sessionStore,
    transcriptStore,
    authProfiles,
    tokenResolver,
    orchestrator,
    health,
    toolRegistry,
    toolApprovalStore,
    memoryStore,
    diagnostics,
    attachmentRecordStore,
    toolPolicy,
    github,
  );
  const bot = new TelegramBotServer(
    config,
    systemClock,
    logger,
    updateStore,
    new AccessController(config, sessionStore, messageStore),
    commands,
    routeResolver,
    orchestrator,
    reactions,
    transcriptStore,
    messageStore,
  );

  return {
    config,
    logger,
    database,
    authProfiles,
    tokenResolver,
    health,
    diagnostics,
    bot,
    dashboard,
    async start() {
      let dashboardStarted = false;
      let leaseStarted = false;
      try {
        instanceLease.start();
        leaseStarted = true;
        await dashboard.start();
        dashboardStarted = true;
        await bot.start();
      } catch (error) {
        if (dashboardStarted) {
          await dashboard.stop();
        }
        if (leaseStarted) {
          instanceLease.stop();
        }
        throw error;
      }
    },
    async stop() {
      await bot.stop();
      await dashboard.stop();
      instanceLease.stop();
      database.close();
    },
  };
}
