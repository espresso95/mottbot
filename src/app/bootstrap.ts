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
import { UsageBudgetService } from "../runs/usage-budget.js";
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
import { createToolPolicyEngine, validateToolPolicyReferences } from "../tools/policy.js";
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
import { createLocalExecToolHandlers } from "../tools/local-exec-handlers.js";
import { createCodexCliToolHandlers } from "../tools/codex-cli-handlers.js";
import { createGithubToolHandlers } from "../tools/github-handlers.js";
import { createMcpToolHandlers } from "../tools/mcp-handlers.js";
import { GithubCliReadService } from "../tools/github-read.js";
import { MicrosoftTodoService } from "../tools/microsoft-todo.js";
import { createMicrosoftTodoToolHandlers } from "../tools/microsoft-todo-handlers.js";
import { GoogleDriveService } from "../tools/google-drive.js";
import { createGoogleDriveToolHandlers } from "../tools/google-drive-handlers.js";
import { TelegramGovernanceStore } from "../telegram/governance.js";
import { ProjectTaskStore } from "../project-tasks/project-task-store.js";
import { CodexCliRunner } from "../codex-cli/codex-cli-runner.js";
import { ProjectTaskScheduler } from "../project-tasks/project-task-scheduler.js";
import { ProjectCommandRouter } from "../project-tasks/project-command-router.js";
import { WorktreeManager } from "../worktrees/worktree-manager.js";

/** Wires persistent stores, Telegram ingress, Codex transport, tools, and lifecycle hooks. */
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
  const governance = new TelegramGovernanceStore(database, systemClock, {
    ownerUserIds: config.telegram.adminUserIds,
  });
  const tokenResolver = new CodexTokenResolver(authProfiles, logger);
  const transport = new CodexTransport(database, logger);
  const updateStore = new TelegramUpdateStore(database, systemClock);
  const messageStore = new TelegramMessageStore(database, systemClock);
  const health = new HealthReporter(config, database, authProfiles, systemClock);
  const diagnostics = new OperatorDiagnostics(config, database, systemClock);
  const usageBudget = new UsageBudgetService(config, runStore, systemClock);
  const github = new GithubCliReadService(config.tools.github);
  const microsoftTodo = new MicrosoftTodoService(config.tools.microsoftTodo);
  const googleDrive = new GoogleDriveService(config.tools.googleDrive);
  const instanceLease = new ApplicationInstanceLease(database, systemClock, logger, {
    leaseName: "bot",
    enabled: config.runtime.instanceLeaseEnabled,
    ttlMs: config.runtime.instanceLeaseTtlMs,
    refreshMs: config.runtime.instanceLeaseRefreshMs,
  });
  const projectTaskStore = new ProjectTaskStore(database, systemClock);
  const codexCliRunner = new CodexCliRunner(projectTaskStore, systemClock, {
    command: config.projectTasks.codex.command,
    coderProfile: config.projectTasks.codex.coderProfile,
    defaultTimeoutMs: config.projectTasks.codex.defaultTimeoutMs,
    artifactRoot: config.projectTasks.artifactRoot,
  });
  const worktrees = new WorktreeManager({
    repoRoots: config.projectTasks.repoRoots,
    worktreeRoot: config.projectTasks.worktreeRoot,
  });

  const routeResolver = new RouteResolver(config, sessionStore);
  const provisionalBot = new TelegramBotServer(
    config,
    systemClock,
    logger,
    updateStore,
    new AccessController(config, sessionStore, messageStore, governance),
    {} as never,
    routeResolver,
    {} as never,
  );
  const projectScheduler = new ProjectTaskScheduler(
    config,
    systemClock,
    projectTaskStore,
    codexCliRunner,
    worktrees,
    ({ task, text }) => {
      void provisionalBot.api.sendMessage(task.chatId, text).catch((error) => {
        logger.warn({ error, taskId: task.taskId }, "Failed to send project completion report.");
      });
    },
  );
  const reactions = new TelegramReactionService(provisionalBot.api);
  const toolRegistry = createRuntimeToolRegistry({
    enableSideEffectTools: config.tools.enableSideEffectTools,
  });
  for (const agent of config.agents.list) {
    validateToolPolicyReferences({
      definitions: toolRegistry.listEnabled(),
      toolNames: agent.toolNames,
      overrides: agent.toolPolicies,
      label: `Agent ${agent.id}`,
    });
  }
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
      ...createLocalExecToolHandlers(config.tools.localExec),
      ...createCodexCliToolHandlers(config, systemClock),
      ...createGithubToolHandlers(github),
      ...createMicrosoftTodoToolHandlers(microsoftTodo),
      ...createGoogleDriveToolHandlers(googleDrive),
      ...createMcpToolHandlers(config.tools.mcp),
    },
    adminUserIds: config.telegram.adminUserIds,
    resolveCallerRole: (userId) => governance.resolveToolCallerRole(userId),
    isToolAllowed: ({ chatId, toolName }) => governance.isToolAllowed({ chatId, toolName }),
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
  const orchestrator = new RunOrchestrator({
    config,
    queue,
    sessions: sessionStore,
    transcripts: transcriptStore,
    runs: runStore,
    tokenResolver,
    transport,
    outbox,
    clock: systemClock,
    logger,
    attachments: attachmentIngestor,
    runQueue: runQueueStore,
    toolRegistry,
    toolExecutor,
    memories: memoryStore,
    modelCapabilities: codexModelCapabilities,
    reactions,
    attachmentRecords: attachmentRecordStore,
    toolPolicy,
    usageBudget,
    governance: {
      resolveCallerRole: (userId) => governance.resolveToolCallerRole(userId),
      isModelAllowed: ({ chatId, modelRef }) => governance.isModelAllowed({ chatId, modelRef }),
      isToolAllowed: ({ chatId, toolName }) => governance.isToolAllowed({ chatId, toolName }),
      validateAttachments: ({ chatId, attachments }) => governance.validateAttachments({ chatId, attachments }),
    },
  });
  orchestrator.recoverQueuedRuns();
  const projectCommands = new ProjectCommandRouter(provisionalBot.api, config, projectTaskStore, projectScheduler);
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
    governance,
    usageBudget,
    projectCommands,
  );
  const bot = new TelegramBotServer(
    config,
    systemClock,
    logger,
    updateStore,
    new AccessController(config, sessionStore, messageStore, governance),
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
    governance,
    usageBudget,
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
        const recoveredProjectRuns = projectTaskStore.recoverInterruptedCliRuns();
        if (recoveredProjectRuns > 0) {
          logger.warn(
            { recoveredProjectRuns },
            "Recovered interrupted Project Mode Codex CLI runs after process restart.",
          );
        }
        projectScheduler.start();
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
      projectScheduler.stop();
      await dashboard.stop();
      instanceLease.stop();
      database.close();
    },
  };
}
