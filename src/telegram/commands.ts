import type { Api } from "grammy";
import type { AgentConfig, AppConfig } from "../app/config.js";
import type { AuthProfileStore } from "../codex/auth-store.js";
import type { CodexTokenResolver } from "../codex/token-resolver.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";
import type { UsageBudgetService } from "../runs/usage-budget.js";
import type { RouteResolver } from "./route-resolver.js";
import type { InboundEvent, TelegramCallbackEvent } from "./types.js";
import type { HealthReporter } from "../app/health.js";
import type { StoredToolApproval, ToolApprovalAuditRecord, ToolApprovalStore } from "../tools/approval.js";
import type { ToolCallerRole, ToolPolicyEngine } from "../tools/policy.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { MemoryStore } from "../sessions/memory-store.js";
import type { SessionRoute } from "../sessions/types.js";
import type { OperatorDiagnostics } from "../app/diagnostics.js";
import type { AttachmentRecordStore } from "../sessions/attachment-store.js";
import type { GithubReadOperations } from "../tools/github-read.js";
import { handleAgentCommand } from "./agent-commands.js";
import { handleAuthCommand } from "./auth-commands.js";
import { commandHelp, formatCommandSection, type CommandHelpEntry } from "./command-formatters.js";
import { parseCommand } from "./command-parsing.js";
import { sendReply } from "./command-replies.js";
import { handleDebugCommand, handleRunsCommand } from "./diagnostic-commands.js";
import { handleFilesCommand } from "./files-commands.js";
import { handleGithubCommand } from "./github-commands.js";
import { isGovernanceOperatorRole, type TelegramGovernanceStore, type TelegramUserRole } from "./governance.js";
import {
  handleForgetCommand,
  handleMemoryCandidateCallback,
  handleMemoryCommand,
  handleRememberCommand,
} from "./memory-commands.js";
import {
  handleBindCommand,
  handleFastCommand,
  handleModelCommand,
  handleProfileCommand,
  handleResetCommand,
  handleStatusCommand,
  handleStopCommand,
  handleUnbindCommand,
  handleUsageCommand,
} from "./session-commands.js";
import { handleToolApprovalCallback, handleToolCommand, handleToolDenyCallback } from "./tool-commands.js";
import { handleUsersCommand } from "./user-commands.js";
import { parseTelegramCallbackData } from "./callback-data.js";

const TELEGRAM_TEXT_MAX_CHARS = 4096;

type CommandVisibility =
  | { allowed: true }
  | {
      allowed: false;
      reason: "chat_not_allowed" | "role_not_allowed" | "command_not_allowed" | "group_policy_required";
    };

function inboundEventFromCallback(event: TelegramCallbackEvent): InboundEvent {
  return {
    updateId: event.updateId,
    chatId: event.chatId,
    chatType: event.chatType,
    messageId: event.messageId,
    ...(typeof event.threadId === "number" ? { threadId: event.threadId } : {}),
    ...(event.fromUserId ? { fromUserId: event.fromUserId } : {}),
    ...(event.fromUsername ? { fromUsername: event.fromUsername } : {}),
    entities: [],
    attachments: [],
    mentionsBot: false,
    isCommand: false,
    arrivedAt: event.arrivedAt,
  };
}

function callbackNotice(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function callbackStatusText(event: TelegramCallbackEvent, status: string): string {
  const cleanStatus = status.replace(/\s+/g, " ").trim();
  const original = event.messageText?.trim();
  if (!original) {
    return cleanStatus;
  }
  const separator = "\n\n";
  const suffix = `${separator}${cleanStatus}`;
  const maxOriginalLength = Math.max(0, TELEGRAM_TEXT_MAX_CHARS - suffix.length);
  return `${original.slice(0, maxOriginalLength).trimEnd()}${suffix}`;
}

/** Dispatches Telegram slash commands for auth, sessions, tools, memory, governance, and diagnostics. */
export class TelegramCommandRouter {
  constructor(
    private readonly api: Api,
    private readonly config: AppConfig,
    private readonly routes: RouteResolver,
    private readonly sessions: SessionStore,
    private readonly transcripts: TranscriptStore,
    private readonly authProfiles: AuthProfileStore,
    private readonly tokenResolver: CodexTokenResolver,
    private readonly orchestrator: RunOrchestrator,
    private readonly health: HealthReporter,
    private readonly toolRegistry?: ToolRegistry,
    private readonly toolApprovals?: ToolApprovalStore,
    private readonly memories?: MemoryStore,
    private readonly diagnostics?: OperatorDiagnostics,
    private readonly attachments?: AttachmentRecordStore,
    private readonly toolPolicy?: ToolPolicyEngine,
    private readonly github?: GithubReadOperations,
    private readonly governance?: TelegramGovernanceStore,
    private readonly usageBudget?: UsageBudgetService,
  ) {}

  async maybeHandle(event: InboundEvent): Promise<boolean> {
    const raw = event.text ?? event.caption;
    if (!raw?.trim().startsWith("/")) {
      return false;
    }
    if (!event.isCommand) {
      return Boolean(event.commandTargetUsername);
    }
    const parsed = parseCommand(raw);
    if (await this.rejectUnauthorizedCommand(event, parsed.command)) {
      return true;
    }
    const session = this.routes.resolve(event);

    switch (parsed.command) {
      case "commands":
      case "help": {
        await sendReply(this.api, event, this.formatHelp(event, session));
        return true;
      }
      case "status": {
        await handleStatusCommand({
          api: this.api,
          event,
          session,
          authProfiles: this.authProfiles,
          tokenResolver: this.tokenResolver,
        });
        return true;
      }
      case "health": {
        await sendReply(this.api, event, this.health.formatForText());
        return true;
      }
      case "usage": {
        await handleUsageCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          usageBudget: this.usageBudget,
        });
        return true;
      }
      case "agent": {
        await handleAgentCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          config: this.config,
          authProfiles: this.authProfiles,
          sessions: this.sessions,
          routes: this.routes,
          usageBudget: this.usageBudget,
          governance: this.governance,
          isAdmin: this.isAdmin(event),
        });
        return true;
      }
      case "tool": {
        await handleToolCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          toolsConfig: this.config.tools,
          exposedTools: this.listExposedToolsForSession(event, session),
          isAdmin: this.isAdmin(event),
          visibleCommandTexts: (entries) => this.visibleCommandTexts(event, entries),
          toolRegistry: this.toolRegistry,
          toolApprovals: this.toolApprovals,
        });
        return true;
      }
      case "tools": {
        await handleToolCommand({
          api: this.api,
          event,
          session,
          args: ["help"],
          toolsConfig: this.config.tools,
          exposedTools: this.listExposedToolsForSession(event, session),
          isAdmin: this.isAdmin(event),
          visibleCommandTexts: (entries) => this.visibleCommandTexts(event, entries),
          toolRegistry: this.toolRegistry,
          toolApprovals: this.toolApprovals,
        });
        return true;
      }
      case "runs": {
        await handleRunsCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          diagnostics: this.diagnostics,
          isAdmin: this.isAdmin(event),
        });
        return true;
      }
      case "debug": {
        await handleDebugCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          health: this.health,
          diagnostics: this.diagnostics,
          isAdmin: this.isAdmin(event),
        });
        return true;
      }
      case "github":
      case "gh": {
        await handleGithubCommand({
          api: this.api,
          event,
          args: parsed.args,
          github: this.github,
          isAdmin: this.isAdmin(event),
        });
        return true;
      }
      case "users": {
        await handleUsersCommand({
          api: this.api,
          event,
          args: parsed.args,
          governance: this.governance,
          role: this.userRole(event),
          isAdmin: this.isAdmin(event),
          isOwner: this.isOwner(event),
        });
        return true;
      }
      case "remember": {
        await handleRememberCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          memories: this.memories,
          governance: this.governance,
        });
        return true;
      }
      case "memory": {
        await handleMemoryCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          memories: this.memories,
          governance: this.governance,
        });
        return true;
      }
      case "forget": {
        await handleForgetCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          memories: this.memories,
        });
        return true;
      }
      case "files": {
        await handleFilesCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          attachments: this.attachments,
          transcripts: this.transcripts,
        });
        return true;
      }
      case "model": {
        await handleModelCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          sessions: this.sessions,
          governance: this.governance,
        });
        return true;
      }
      case "profile": {
        await handleProfileCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          sessions: this.sessions,
          authProfiles: this.authProfiles,
        });
        return true;
      }
      case "fast": {
        await handleFastCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          sessions: this.sessions,
        });
        return true;
      }
      case "new":
      case "reset": {
        await handleResetCommand({
          api: this.api,
          event,
          session,
          transcripts: this.transcripts,
        });
        return true;
      }
      case "stop": {
        await handleStopCommand({
          api: this.api,
          event,
          session,
          orchestrator: this.orchestrator,
        });
        return true;
      }
      case "bind": {
        await handleBindCommand({
          api: this.api,
          event,
          session,
          args: parsed.args,
          sessions: this.sessions,
        });
        return true;
      }
      case "unbind": {
        await handleUnbindCommand({
          api: this.api,
          event,
          session,
          sessions: this.sessions,
        });
        return true;
      }
      case "auth": {
        await handleAuthCommand({
          api: this.api,
          event,
          args: parsed.args,
          config: this.config,
          authProfiles: this.authProfiles,
        });
        return true;
      }
      default:
        return false;
    }
  }

  async maybeHandleCallback(event: TelegramCallbackEvent): Promise<boolean> {
    const action = parseTelegramCallbackData(event.data);
    if (!action) {
      return false;
    }
    if (action.type === "tool_approve" || action.type === "tool_deny") {
      if (await this.rejectUnauthorizedCallback(event, "tool")) {
        return true;
      }
      const inbound = inboundEventFromCallback(event);
      const session = this.routes.resolve(inbound);
      const dependencies = {
        api: this.api,
        event,
        session,
        toolsConfig: this.config.tools,
        isAdmin: this.isAdmin(inbound),
        toolRegistry: this.toolRegistry,
        toolApprovals: this.toolApprovals,
        continueAfterApproval: async (params: {
          event: InboundEvent;
          session: SessionRoute;
          pending: ToolApprovalAuditRecord;
          approval: StoredToolApproval;
        }) => {
          const continued =
            (await this.orchestrator.continueApprovedTool?.({
              event: params.event,
              session: params.session,
              pending: params.pending,
            })) ?? false;
          if (continued) {
            return;
          }
          await this.orchestrator.enqueueMessage({
            event: params.event,
            session: params.session,
          });
        },
      };
      if (action.type === "tool_approve") {
        await handleToolApprovalCallback(dependencies, action.auditId);
        return true;
      }
      await handleToolDenyCallback(dependencies, action.auditId);
      return true;
    }
    if (
      action.type === "run_stop" ||
      action.type === "run_retry" ||
      action.type === "run_new" ||
      action.type === "run_usage" ||
      action.type === "run_files"
    ) {
      const command =
        action.type === "run_stop"
          ? "stop"
          : action.type === "run_usage"
            ? "usage"
            : action.type === "run_files"
              ? "files"
              : "new";
      if (await this.rejectUnauthorizedCallback(event, command)) {
        return true;
      }
      const inbound = inboundEventFromCallback(event);
      const session = this.routes.resolve(inbound);
      if (action.type === "run_stop") {
        const stopped = await this.orchestrator.stop(session.sessionKey, action.runId);
        const callbackText = stopped ? "I stopped the active run." : "I could not find an active run to stop.";
        await this.answerCallback(event, callbackText, !stopped);
        await this.editRunCallbackStatus(
          event,
          stopped ? "Stopped the active run." : "Stop was not applied. I could not find an active run.",
        );
        return true;
      }
      if (action.type === "run_retry") {
        const result = await this.orchestrator.retryRun({
          event: inbound,
          session,
          runId: action.runId,
        });
        const copy = this.formatRunRetryResult(result);
        await this.answerCallback(event, copy.callbackText, copy.showAlert);
        await this.editRunCallbackStatus(event, copy.statusText);
        return true;
      }
      if (action.type === "run_new") {
        const message = "I started a new chat and cleared the previous context.";
        await this.answerCallback(event, message);
        this.transcripts.clearSession(session.sessionKey);
        await this.editRunCallbackStatus(event, message);
        return true;
      }
      if (action.type === "run_usage") {
        await this.answerCallback(event, "Showing usage.");
        await handleUsageCommand({
          api: this.api,
          event: inbound,
          session,
          args: [],
          usageBudget: this.usageBudget,
        });
        return true;
      }
      await this.answerCallback(event, "Showing files.");
      await handleFilesCommand({
        api: this.api,
        event: inbound,
        session,
        args: [],
        attachments: this.attachments,
        transcripts: this.transcripts,
      });
      return true;
    }
    if (action.type === "memory_accept" || action.type === "memory_reject" || action.type === "memory_archive") {
      if (await this.rejectUnauthorizedCallback(event, "memory")) {
        return true;
      }
      const inbound = inboundEventFromCallback(event);
      await handleMemoryCandidateCallback(
        {
          api: this.api,
          event,
          session: this.routes.resolve(inbound),
          memories: this.memories,
          governance: this.governance,
        },
        action.type === "memory_accept" ? "accept" : action.type === "memory_reject" ? "reject" : "archive",
        action.candidateId,
      );
      return true;
    }
    return false;
  }

  private formatRunRetryResult(result: Awaited<ReturnType<RunOrchestrator["retryRun"]>>): {
    callbackText: string;
    statusText: string;
    showAlert: boolean;
  } {
    switch (result) {
      case "queued":
        return {
          callbackText: "Retrying that request now.",
          statusText: "Retrying that request now.",
          showAlert: false,
        };
      case "not_found":
        return {
          callbackText: "I cannot retry that run because it is no longer available.",
          statusText: "Retry was not applied. The run is no longer available.",
          showAlert: true,
        };
      case "wrong_session":
        return {
          callbackText: "I cannot retry that run from this chat.",
          statusText: "Retry was not applied. The run belongs to another session.",
          showAlert: true,
        };
      case "not_retryable":
        return {
          callbackText: "This run cannot be retried.",
          statusText: "Retry was not applied. This run is not in a retryable state.",
          showAlert: true,
        };
      case "no_user_message":
        return {
          callbackText: "I cannot retry because the original user message is no longer available.",
          statusText: "Retry was not applied. The original user message is no longer available.",
          showAlert: true,
        };
      case "attachments_not_retryable":
        return {
          callbackText:
            "I cannot retry this from here because the original message included a file. Send the file again and I will run it as a fresh request.",
          statusText:
            "Retry was not applied. The original message included a file; send the file again to run it as a fresh request.",
          showAlert: true,
        };
    }
  }

  private async rejectUnauthorizedCommand(event: InboundEvent, command: string): Promise<boolean> {
    const decision = this.commandVisibility(event, command);
    if (decision.allowed) {
      return false;
    }
    if (decision.reason === "chat_not_allowed") {
      await sendReply(this.api, event, "This chat is not allowed to use this bot.");
      return true;
    }
    if (decision.reason === "role_not_allowed") {
      await sendReply(this.api, event, "Your role is not allowed to use this chat.");
      return true;
    }
    if (decision.reason === "command_not_allowed") {
      await sendReply(this.api, event, "Your role is not allowed to run this command in this chat.");
      return true;
    }
    if (decision.reason === "group_policy_required") {
      await sendReply(
        this.api,
        event,
        "Only owner/admin roles can run bot commands in groups unless a chat policy allows the command.",
      );
      return true;
    }
    return true;
  }

  private async rejectUnauthorizedCallback(event: TelegramCallbackEvent, command: string): Promise<boolean> {
    const inbound = inboundEventFromCallback(event);
    const decision = this.commandVisibility(inbound, command);
    if (decision.allowed) {
      return false;
    }
    const message =
      decision.reason === "chat_not_allowed"
        ? "This chat is not allowed to use this bot."
        : decision.reason === "role_not_allowed"
          ? "Your role is not allowed to use this chat."
          : decision.reason === "command_not_allowed"
            ? "Your role is not allowed to run this command in this chat."
            : "Only owner/admin roles can run bot commands in groups unless a chat policy allows the command.";
    await this.answerCallback(event, message, true);
    await sendReply(this.api, event, message);
    return true;
  }

  private async answerCallback(event: TelegramCallbackEvent, text: string, showAlert = false): Promise<void> {
    await this.api.answerCallbackQuery(event.callbackQueryId, {
      text: callbackNotice(text),
      show_alert: showAlert,
    });
  }

  private async editRunCallbackStatus(event: TelegramCallbackEvent, status: string): Promise<void> {
    try {
      await this.api.editMessageText(event.chatId, event.messageId, callbackStatusText(event, status));
    } catch {
      // Some Telegram messages cannot be edited; keyboard cleanup still prevents stale taps.
    }
    try {
      await this.api.editMessageReplyMarkup(event.chatId, event.messageId);
    } catch {
      // Source message cleanup is best effort after the command has already been handled.
    }
  }

  private commandVisibility(event: InboundEvent, command: string): CommandVisibility {
    const role = this.userRole(event);
    if (isGovernanceOperatorRole(role)) {
      return { allowed: true };
    }
    if (this.config.telegram.allowedChatIds.length > 0 && !this.config.telegram.allowedChatIds.includes(event.chatId)) {
      return { allowed: false, reason: "chat_not_allowed" };
    }
    if (this.governance && !this.governance.isChatAllowed({ chatId: event.chatId, userId: event.fromUserId })) {
      return { allowed: false, reason: "role_not_allowed" };
    }
    if (
      this.governance &&
      !this.governance.isCommandAllowed({ chatId: event.chatId, userId: event.fromUserId, command })
    ) {
      return { allowed: false, reason: "command_not_allowed" };
    }
    if (event.chatType !== "private" && !this.governance?.hasCommandPolicy({ chatId: event.chatId, command })) {
      return { allowed: false, reason: "group_policy_required" };
    }
    return { allowed: true };
  }

  private isCommandVisible(event: InboundEvent, command: string): boolean {
    return this.commandVisibility(event, command).allowed;
  }

  private visibleCommandTexts(event: InboundEvent, entries: readonly CommandHelpEntry[]): string[] {
    return entries
      .filter((entry) => entry.commands.some((command) => this.isCommandVisible(event, command)))
      .map((entry) => entry.text);
  }

  private userRole(event: InboundEvent): TelegramUserRole {
    return (
      this.governance?.resolveUserRole(event.fromUserId) ??
      (event.fromUserId && this.config.telegram.adminUserIds.includes(event.fromUserId) ? "owner" : "user")
    );
  }

  private isAdmin(event: InboundEvent): boolean {
    return isGovernanceOperatorRole(this.userRole(event));
  }

  private isOwner(event: InboundEvent): boolean {
    return this.userRole(event) === "owner";
  }

  private callerRole(event: InboundEvent): ToolCallerRole {
    return this.userRole(event);
  }

  private listExposedToolsForSession(event: InboundEvent, session: SessionRoute) {
    const agent = this.agentForSession(session);
    return (
      this.toolRegistry?.listModelDeclarations({
        includeAdminTools: this.isAdmin(event),
        filter: (definition) =>
          (!agent?.toolNames || agent.toolNames.length === 0 || agent.toolNames.includes(definition.name)) &&
          (this.toolPolicy?.evaluate(
            definition,
            {
              role: this.callerRole(event),
              chatId: event.chatId,
            },
            {
              override: agent?.toolPolicies?.[definition.name],
            },
          ).allowed ??
            true) &&
          (this.governance?.isToolAllowed({
            chatId: event.chatId,
            toolName: definition.name,
          }) ??
            true),
      }) ?? []
    );
  }

  private agentForSession(session: SessionRoute): AgentConfig | undefined {
    return this.config.agents.list.find((agent) => agent.id === session.agentId);
  }

  private formatHelp(event: InboundEvent, session: SessionRoute): string {
    const isAdmin = this.isAdmin(event);
    const exposedTools = this.listExposedToolsForSession(event, session);
    const sections = [
      [
        "Mottbot help",
        `Session: ${session.sessionKey}`,
        `Model: ${session.modelRef}`,
        `Profile: ${session.profileId}`,
      ].join("\n"),
      formatCommandSection(
        "Discovery",
        this.visibleCommandTexts(event, [
          commandHelp("help", "/help - show commands available to this caller"),
          commandHelp("commands", "/commands - same as /help"),
        ]),
      ),
      formatCommandSection(
        "Session",
        this.visibleCommandTexts(event, [
          commandHelp("status", "/status - show session, model, profile, and usage"),
          commandHelp("health", "/health - show runtime health"),
          commandHelp("usage", "/usage [daily|monthly] - show local run usage and configured limits"),
          commandHelp("agent", "/agent [list|show|set|reset] - inspect or change this session agent"),
          commandHelp("model", "/model <provider/model> - change this session model"),
          commandHelp("profile", "/profile [profile-id] - list or select auth profile"),
          commandHelp("fast", "/fast on|off - toggle priority service tier"),
          commandHelp(["new", "reset"], "/new or /reset - clear this session transcript"),
          commandHelp("stop", "/stop - cancel the active run for this session"),
          commandHelp("files", "/files [forget <id-prefix>|clear] - inspect or forget uploaded file metadata"),
          commandHelp("bind", "/bind [name] - keep replies always on for this chat or topic"),
          commandHelp("unbind", "/unbind - restore default route behavior"),
        ]),
      ),
      this.memories
        ? formatCommandSection(
            "Memory",
            this.visibleCommandTexts(event, [
              commandHelp("remember", "/remember <fact> - store memory for this session"),
              commandHelp("remember", "/remember scope:personal <fact> - store user-scoped memory"),
              commandHelp("memory", "/memory - list approved memory for this chat"),
              commandHelp(
                "memory",
                "/memory candidates [pending|accepted|rejected|archived|all] - list memory candidates",
              ),
              commandHelp("memory", "/memory accept|reject|edit <candidate-id-prefix> - review candidates"),
              commandHelp("memory", "/memory pin|unpin|archive <memory-id-prefix> - manage approved memory"),
              commandHelp("memory", "/memory clear candidates - clear pending candidates"),
              commandHelp("forget", "/forget <memory-id-prefix|all|auto> - remove memory"),
            ]),
          )
        : undefined,
      this.toolRegistry && this.toolApprovals
        ? formatCommandSection(
            "Tools",
            this.visibleCommandTexts(event, [
              commandHelp("tool", "/tool status - show model-exposed tools and approvals"),
              commandHelp("tool", "/tool help - show tool command help"),
              commandHelp("tools", "/tools - show tool command help"),
              ...(isAdmin
                ? [
                    commandHelp("tool", "/tool approve <tool-name> <reason> - approve one side-effecting call"),
                    commandHelp("tool", "/tool revoke <tool-name> - revoke active approval"),
                    commandHelp(
                      "tool",
                      "/tool audit [limit] [here] [tool:<name>] [code:<decision>] - inspect tool audit records",
                    ),
                  ]
                : []),
            ]),
          )
        : undefined,
      formatCommandSection(
        "Auth",
        this.visibleCommandTexts(event, [
          commandHelp("auth", "/auth status - list configured auth profiles"),
          commandHelp("auth", "/auth login - show host-local OAuth command"),
          commandHelp("auth", "/auth import-cli - import Codex CLI credentials on this host"),
        ]),
      ),
      isAdmin && this.diagnostics
        ? formatCommandSection(
            "Admin diagnostics",
            this.visibleCommandTexts(event, [
              commandHelp("runs", "/runs [limit] [here] - list recent runs"),
              commandHelp("debug", "/debug summary|service|runs|agents|errors|logs|config - inspect diagnostics"),
            ]),
          )
        : undefined,
      isAdmin && this.github
        ? formatCommandSection(
            "GitHub",
            this.visibleCommandTexts(event, [
              commandHelp(["github", "gh"], "/github status [repository] - show repository, open work, and latest CI"),
              commandHelp(
                ["github", "gh"],
                "/github prs|issues|runs|failures [limit] [repository] - inspect GitHub read-only state",
              ),
            ]),
          )
        : undefined,
      this.governance
        ? formatCommandSection(
            "Governance",
            this.visibleCommandTexts(event, [
              commandHelp("users", "/users me - show your role"),
              ...(isAdmin
                ? [
                    commandHelp("users", "/users list - list configured roles"),
                    commandHelp("users", "/users audit [limit] - inspect role and chat-policy audit records"),
                    commandHelp("users", "/users chat show [chat-id] - show chat policy"),
                  ]
                : []),
              ...(this.isOwner(event)
                ? [
                    commandHelp("users", "/users grant <user-id> <owner|admin|trusted> [reason] - grant a role"),
                    commandHelp("users", "/users revoke <user-id> [reason] - revoke a database role"),
                    commandHelp("users", "/users chat set [chat-id] <json> - set chat policy"),
                    commandHelp("users", "/users chat clear [chat-id] - clear chat policy"),
                  ]
                : []),
            ]),
          )
        : undefined,
      this.toolRegistry
        ? exposedTools.length > 0
          ? ["Model-exposed tools for this caller:", ...exposedTools.map((tool) => `- ${tool.name}`)].join("\n")
          : "No model-exposed tools for this caller."
        : undefined,
    ].filter((section): section is string => Boolean(section));
    return sections.join("\n\n");
  }
}
