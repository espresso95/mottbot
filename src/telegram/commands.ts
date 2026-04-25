import type { Api } from "grammy";
import type { AgentConfig, AppConfig } from "../app/config.js";
import type { AuthProfileStore } from "../codex/auth-store.js";
import { isCodexModelRef, isKnownCodexModelRef, KNOWN_CODEX_MODEL_REFS_TEXT } from "../codex/provider.js";
import type { CodexTokenResolver } from "../codex/token-resolver.js";
import { fetchCodexUsage } from "../codex/usage.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";
import type { UsageBudgetService } from "../runs/usage-budget.js";
import type { ProjectCommandRouter } from "../project-tasks/project-command-router.js";
import type { RouteResolver } from "./route-resolver.js";
import type { InboundEvent } from "./types.js";
import type { HealthReporter } from "../app/health.js";
import type { ToolApprovalDecision, ToolApprovalStore } from "../tools/approval.js";
import type { ToolCallerRole, ToolPolicyEngine } from "../tools/policy.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { MemoryStore } from "../sessions/memory-store.js";
import type { SessionRoute } from "../sessions/types.js";
import type { OperatorDiagnostics } from "../app/diagnostics.js";
import type { AttachmentRecordStore } from "../sessions/attachment-store.js";
import type { GithubReadOperations } from "../tools/github-read.js";
import { handleAuthCommand } from "./auth-commands.js";
import {
  TOOL_AUDIT_DECISION_CODES,
  commandHelp,
  formatAgentDetails,
  formatAgentLine,
  formatChatPolicy,
  formatCommandSection,
  formatGovernanceAuditRecord,
  formatRoleRecord,
  formatToolAuditRecord,
  formatUsageSummary,
  isToolAuditDecisionCode,
  type CommandHelpEntry,
} from "./command-formatters.js";
import {
  PROFILE_ID_PATTERN,
  normalizeBindingName,
  normalizeFreeText,
  normalizeSingleArg,
  parseBoundedLimit,
  parseCommand,
  validateBindingName,
} from "./command-parsing.js";
import { sendReply } from "./command-replies.js";
import { handleDebugCommand, handleRunsCommand } from "./diagnostic-commands.js";
import { handleFilesCommand } from "./files-commands.js";
import { handleGithubCommand } from "./github-commands.js";
import {
  isGovernanceOperatorRole,
  parseChatGovernancePolicy,
  parseTelegramUserRole,
  type ChatGovernancePolicy,
  type TelegramGovernanceStore,
  type TelegramUserRole,
} from "./governance.js";
import { handleForgetCommand, handleMemoryCommand, handleRememberCommand } from "./memory-commands.js";

type CommandVisibility =
  | { allowed: true }
  | {
      allowed: false;
      reason: "chat_not_allowed" | "role_not_allowed" | "command_not_allowed" | "group_policy_required";
    };

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
    private readonly projects?: ProjectCommandRouter,
  ) {}

  async maybeHandle(event: InboundEvent): Promise<boolean> {
    const raw = event.text ?? event.caption;
    if (!raw?.trim().startsWith("/")) {
      return false;
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
        const authCount = this.authProfiles.list().length;
        let usageSummary = "Usage unavailable";
        try {
          const auth = await this.tokenResolver.resolve(session.profileId);
          const usage = await fetchCodexUsage({
            accessToken: auth.accessToken,
            accountId: auth.accountId,
          });
          usageSummary = formatUsageSummary(usage);
        } catch {
          // keep fallback summary
        }
        await sendReply(
          this.api,
          event,
          [
            `Session: ${session.sessionKey}`,
            `Agent: ${session.agentId}`,
            `Model: ${session.modelRef}`,
            `Profile: ${session.profileId}`,
            `Fast mode: ${session.fastMode ? "on" : "off"}`,
            `Auth profiles: ${authCount}`,
            `Usage: ${usageSummary}`,
          ].join("\n"),
        );
        return true;
      }
      case "health": {
        await sendReply(this.api, event, this.health.formatForText());
        return true;
      }
      case "usage": {
        await this.handleUsageCommand(event, session, parsed.args);
        return true;
      }
      case "project": {
        if (!this.projects) {
          await sendReply(this.api, event, "Project mode is not available.");
          return true;
        }
        await this.projects.handle(event, parsed.args);
        return true;
      }
      case "agent": {
        await this.handleAgentCommand(event, session, parsed.args);
        return true;
      }
      case "tool": {
        await this.handleToolCommand(event, session, parsed.args);
        return true;
      }
      case "tools": {
        await this.handleToolCommand(event, session, ["help"]);
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
        await this.handleUsersCommand(event, parsed.args);
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
        const nextModelRef = normalizeSingleArg(parsed.args[0]);
        if (!nextModelRef) {
          await sendReply(this.api, event, "Usage: /model <provider/model>");
          return true;
        }
        if (!isKnownCodexModelRef(nextModelRef)) {
          await sendReply(
            this.api,
            event,
            `Unknown model ${nextModelRef}. Supported models: ${KNOWN_CODEX_MODEL_REFS_TEXT}.`,
          );
          return true;
        }
        if (this.governance && !this.governance.isModelAllowed({ chatId: event.chatId, modelRef: nextModelRef })) {
          await sendReply(this.api, event, `Model ${nextModelRef} is not allowed in this chat.`);
          return true;
        }
        this.sessions.setModelRef(session.sessionKey, nextModelRef);
        await sendReply(this.api, event, `Model set to ${nextModelRef}.`);
        return true;
      }
      case "profile": {
        const nextProfileId = normalizeSingleArg(parsed.args[0]);
        if (!nextProfileId) {
          const profiles = this.authProfiles.list();
          await sendReply(
            this.api,
            event,
            profiles.length > 0
              ? `Profiles:\n${profiles.map((profile) => `- ${profile.profileId} (${profile.source})`).join("\n")}`
              : "No auth profiles found.",
          );
          return true;
        }
        if (!PROFILE_ID_PATTERN.test(nextProfileId)) {
          await sendReply(
            this.api,
            event,
            "Invalid profile ID. Use 1-128 letters, numbers, dots, slashes, underscores, colons, or hyphens.",
          );
          return true;
        }
        if (!this.authProfiles.get(nextProfileId)) {
          await sendReply(this.api, event, `Unknown profile ${nextProfileId}.`);
          return true;
        }
        this.sessions.setProfileId(session.sessionKey, nextProfileId);
        await sendReply(this.api, event, `Profile set to ${nextProfileId}.`);
        return true;
      }
      case "fast": {
        if (!parsed.args[0] || !["on", "off"].includes(parsed.args[0])) {
          await sendReply(this.api, event, "Usage: /fast on|off");
          return true;
        }
        const next = parsed.args[0] === "on";
        this.sessions.setFastMode(session.sessionKey, next);
        await sendReply(this.api, event, `Fast mode ${next ? "enabled" : "disabled"}.`);
        return true;
      }
      case "new":
      case "reset": {
        this.transcripts.clearSession(session.sessionKey);
        await sendReply(this.api, event, "Session transcript cleared.");
        return true;
      }
      case "stop": {
        const stopped = await this.orchestrator.stop(session.sessionKey);
        await sendReply(this.api, event, stopped ? "Active run cancelled." : "No active run.");
        return true;
      }
      case "bind": {
        const bindingName = normalizeBindingName(parsed.args);
        if (!validateBindingName(bindingName)) {
          await sendReply(this.api, event, "Invalid binding name. Use 1-64 visible characters.");
          return true;
        }
        this.sessions.bind(session.sessionKey, bindingName);
        await sendReply(this.api, event, "Route bound for always-on replies in this chat/topic.");
        return true;
      }
      case "unbind": {
        this.sessions.unbind(session.sessionKey);
        await sendReply(this.api, event, "Route unbound.");
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

  private async requireAdmin(event: InboundEvent, action: string): Promise<boolean> {
    if (this.isAdmin(event)) {
      return true;
    }
    await sendReply(this.api, event, `Only owner/admin roles can ${action}.`);
    return false;
  }

  private async requireOwner(event: InboundEvent, action: string): Promise<boolean> {
    if (this.isOwner(event)) {
      return true;
    }
    await sendReply(this.api, event, `Only owner roles can ${action}.`);
    return false;
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
          commandHelp("project", "/project start|status|tail|cancel|cleanup|publish|approve - run long project tasks"),
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

  private async handleUsageCommand(event: InboundEvent, session: SessionRoute, args: string[]): Promise<void> {
    if (!this.usageBudget) {
      await sendReply(this.api, event, "Usage budgets are not available.");
      return;
    }
    const selectedWindow = args[0]?.toLowerCase();
    if (selectedWindow && selectedWindow !== "daily" && selectedWindow !== "monthly") {
      await sendReply(this.api, event, "Usage: /usage [daily|monthly]");
      return;
    }
    const window = selectedWindow === "monthly" ? "monthly" : "daily";
    await sendReply(this.api, event, this.usageBudget.formatUsageReport({ session, window }));
  }

  private async handleAgentCommand(event: InboundEvent, session: SessionRoute, args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase() ?? "show";
    if (sub === "list") {
      await sendReply(
        this.api,
        event,
        [
          "Configured agents:",
          ...this.config.agents.list.map((agent) =>
            formatAgentLine(agent, { currentId: session.agentId, defaultId: this.config.agents.defaultId }),
          ),
        ].join("\n"),
      );
      return;
    }
    if (sub === "show") {
      const requestedAgentId = normalizeSingleArg(args[1]);
      const agent = requestedAgentId ? this.findAgent(requestedAgentId) : this.agentForSession(session);
      if (!agent) {
        await sendReply(
          this.api,
          event,
          requestedAgentId
            ? `Unknown agent ${requestedAgentId}.`
            : `Current route agent ${session.agentId} is not in the current config.`,
        );
        return;
      }
      await sendReply(this.api, event, formatAgentDetails(agent));
      return;
    }
    if (sub === "set") {
      if (!(await this.requireAdmin(event, "change session agents"))) {
        return;
      }
      const agentId = normalizeSingleArg(args[1]);
      const agent = agentId ? this.findAgent(agentId) : undefined;
      if (!agent) {
        await sendReply(this.api, event, "Usage: /agent set <agent-id>");
        return;
      }
      await this.applyAgentSelection(event, session, agent, "Agent set");
      return;
    }
    if (sub === "reset") {
      if (!(await this.requireAdmin(event, "reset session agents"))) {
        return;
      }
      await this.applyAgentSelection(event, session, this.routes.selectAgent(event), "Agent reset");
      return;
    }
    await sendReply(this.api, event, "Usage: /agent [list|show [agent-id]|set <agent-id>|reset]");
  }

  private findAgent(agentId: string): AgentConfig | undefined {
    return this.config.agents.list.find((agent) => agent.id === agentId);
  }

  private sessionWithAgent(session: SessionRoute, agent: AgentConfig): SessionRoute {
    return {
      ...session,
      agentId: agent.id,
      profileId: agent.profileId,
      modelRef: agent.modelRef,
      fastMode: agent.fastMode,
      systemPrompt: agent.systemPrompt,
    };
  }

  private validateAgentSelection(
    event: InboundEvent,
    session: SessionRoute,
    agent: AgentConfig,
  ): { allowed: true; warnings: string[] } | { allowed: false; message: string } {
    if (!isCodexModelRef(agent.modelRef)) {
      return { allowed: false, message: `Invalid agent model ${agent.modelRef}. Expected openai-codex/<model>.` };
    }
    if (!this.authProfiles.get(agent.profileId)) {
      return { allowed: false, message: `Agent profile ${agent.profileId} is not configured.` };
    }
    if (this.governance && !this.governance.isModelAllowed({ chatId: event.chatId, modelRef: agent.modelRef })) {
      return { allowed: false, message: `Agent model ${agent.modelRef} is not allowed in this chat.` };
    }
    const nextSession = this.sessionWithAgent(session, agent);
    const budgetDecision = this.usageBudget?.evaluate({
      session: nextSession,
      modelRef: agent.modelRef,
    });
    if (budgetDecision && !budgetDecision.allowed) {
      return {
        allowed: false,
        message: budgetDecision.deniedReason ?? `Agent model ${agent.modelRef} exceeds a usage budget.`,
      };
    }
    return {
      allowed: true,
      warnings: budgetDecision?.warnings ?? [],
    };
  }

  private async applyAgentSelection(
    event: InboundEvent,
    session: SessionRoute,
    agent: AgentConfig,
    label: string,
  ): Promise<void> {
    const decision = this.validateAgentSelection(event, session, agent);
    if (!decision.allowed) {
      await sendReply(this.api, event, decision.message);
      return;
    }
    this.sessions.setAgent(session.sessionKey, agent);
    await sendReply(
      this.api,
      event,
      [
        `${label} to ${agent.id}.`,
        `Model: ${agent.modelRef}`,
        `Profile: ${agent.profileId}`,
        `Fast mode: ${agent.fastMode ? "on" : "off"}`,
        ...decision.warnings,
      ].join("\n"),
    );
  }

  private async handleUsersCommand(event: InboundEvent, args: string[]): Promise<void> {
    if (!this.governance) {
      await sendReply(this.api, event, "User governance is not available.");
      return;
    }
    const sub = args[0]?.toLowerCase() ?? "me";
    if (sub === "me") {
      await sendReply(this.api, event, `Your role: ${this.userRole(event)}`);
      return;
    }
    if (sub === "list") {
      if (!(await this.requireAdmin(event, "list user roles"))) {
        return;
      }
      const roles = this.governance.listRoles();
      await sendReply(
        this.api,
        event,
        roles.length > 0 ? ["User roles:", ...roles.map(formatRoleRecord)].join("\n") : "No roles configured.",
      );
      return;
    }
    if (sub === "grant") {
      if (!(await this.requireOwner(event, "grant user roles"))) {
        return;
      }
      const userId = normalizeSingleArg(args[1]);
      const role = parseTelegramUserRole(args[2]);
      if (!userId || !role || role === "user") {
        await sendReply(this.api, event, "Usage: /users grant <user-id> <owner|admin|trusted> [reason]");
        return;
      }
      try {
        const granted = this.governance.setUserRole({
          userId,
          role,
          actorUserId: event.fromUserId,
          reason: normalizeFreeText(args.slice(3)) || undefined,
        });
        await sendReply(
          this.api,
          event,
          granted ? `Granted ${granted.role} to ${granted.userId}.` : `Revoked ${userId}.`,
        );
      } catch (error) {
        await sendReply(this.api, event, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (sub === "revoke") {
      if (!(await this.requireOwner(event, "revoke user roles"))) {
        return;
      }
      const userId = normalizeSingleArg(args[1]);
      if (!userId) {
        await sendReply(this.api, event, "Usage: /users revoke <user-id> [reason]");
        return;
      }
      try {
        const revoked = this.governance.revokeUserRole({
          userId,
          actorUserId: event.fromUserId,
          reason: normalizeFreeText(args.slice(2)) || undefined,
        });
        await sendReply(
          this.api,
          event,
          revoked ? `Revoked role for ${userId}.` : `No database role found for ${userId}.`,
        );
      } catch (error) {
        await sendReply(this.api, event, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (sub === "audit") {
      if (!(await this.requireAdmin(event, "inspect user governance audit records"))) {
        return;
      }
      const limit = parseBoundedLimit(args[1], 10);
      const records = this.governance.listAudit(limit);
      await sendReply(
        this.api,
        event,
        records.length > 0
          ? ["User governance audit:", ...records.map(formatGovernanceAuditRecord)].join("\n")
          : "No governance audit records.",
      );
      return;
    }
    if (sub === "chat") {
      await this.handleUsersChatCommand(event, args.slice(1));
      return;
    }
    await sendReply(this.api, event, this.formatUsersHelp(event));
  }

  private async handleUsersChatCommand(event: InboundEvent, args: string[]): Promise<void> {
    if (!this.governance) {
      await sendReply(this.api, event, "User governance is not available.");
      return;
    }
    const sub = args[0]?.toLowerCase() ?? "show";
    if (sub === "show") {
      if (!(await this.requireAdmin(event, "inspect chat policy"))) {
        return;
      }
      const chatId = normalizeSingleArg(args[1]) ?? event.chatId;
      await sendReply(this.api, event, formatChatPolicy(this.governance.getChatPolicy(chatId), chatId));
      return;
    }
    if (sub === "set") {
      if (!(await this.requireOwner(event, "set chat policy"))) {
        return;
      }
      const parsed = this.parseChatPolicySetArgs(event, args.slice(1));
      if ("error" in parsed) {
        await sendReply(this.api, event, parsed.error);
        return;
      }
      try {
        const policy = this.governance.setChatPolicy({
          chatId: parsed.chatId,
          policy: parsed.policy,
          actorUserId: event.fromUserId,
        });
        await sendReply(this.api, event, formatChatPolicy(policy, parsed.chatId));
      } catch (error) {
        await sendReply(this.api, event, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (sub === "clear") {
      if (!(await this.requireOwner(event, "clear chat policy"))) {
        return;
      }
      const chatId = normalizeSingleArg(args[1]) ?? event.chatId;
      const cleared = this.governance.clearChatPolicy({ chatId, actorUserId: event.fromUserId });
      await sendReply(
        this.api,
        event,
        cleared ? `Cleared chat policy for ${chatId}.` : `No chat policy set for ${chatId}.`,
      );
      return;
    }
    await sendReply(this.api, event, "Usage: /users chat show [chat-id] | set [chat-id] <json> | clear [chat-id]");
  }

  private parseChatPolicySetArgs(
    event: InboundEvent,
    args: string[],
  ): { chatId: string; policy: ChatGovernancePolicy } | { error: string } {
    const first = args[0];
    if (!first) {
      return { error: "Usage: /users chat set [chat-id] <json>" };
    }
    const jsonStartsAt = first.trim().startsWith("{") ? 0 : 1;
    const chatId = jsonStartsAt === 0 ? event.chatId : normalizeSingleArg(first);
    const rawJson = normalizeFreeText(args.slice(jsonStartsAt));
    if (!chatId || !rawJson) {
      return { error: "Usage: /users chat set [chat-id] <json>" };
    }
    try {
      return {
        chatId,
        policy: parseChatGovernancePolicy(rawJson),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private formatUsersHelp(event: InboundEvent): string {
    const commands = [
      "/users me - show your role",
      ...(this.isAdmin(event)
        ? [
            "/users list - list configured roles",
            "/users audit [limit] - inspect role and chat-policy audit records",
            "/users chat show [chat-id] - show chat policy",
          ]
        : []),
      ...(this.isOwner(event)
        ? [
            "/users grant <user-id> <owner|admin|trusted> [reason] - grant a role",
            "/users revoke <user-id> [reason] - revoke a database role",
            "/users chat set [chat-id] <json> - set chat policy",
            "/users chat clear [chat-id] - clear chat policy",
          ]
        : []),
    ];
    return ["User governance", ...commands.map((command) => `- ${command}`)].join("\n");
  }

  private async handleToolCommand(event: InboundEvent, session: SessionRoute, args: string[]): Promise<void> {
    const sub = args[0]?.toLowerCase();
    if (!this.toolRegistry || !this.toolApprovals) {
      await sendReply(this.api, event, "Tool approvals are not available.");
      return;
    }
    if (sub === "help") {
      await sendReply(this.api, event, this.formatToolHelp(event, session));
      return;
    }
    if (!sub || sub === "status") {
      const tools = this.toolRegistry.listEnabled();
      const exposedTools = this.listExposedToolsForSession(event, session);
      const approvals = this.toolApprovals.listActive(session.sessionKey);
      await sendReply(
        this.api,
        event,
        [
          exposedTools.length > 0
            ? `Model-exposed tools for this caller:\n${exposedTools.map((tool) => `- ${tool.name}`).join("\n")}`
            : "No model-exposed tools for this caller.",
          tools.length > 0
            ? `Enabled tools:\n${tools.map((tool) => `- ${tool.name} (${tool.sideEffect})`).join("\n")}`
            : "No enabled tools.",
          approvals.length > 0
            ? `Active approvals:\n${approvals
                .map((approval) => `- ${approval.toolName}, expires ${new Date(approval.expiresAt).toISOString()}`)
                .join("\n")}`
            : "No active approvals.",
        ].join("\n\n"),
      );
      return;
    }
    if (sub === "audit") {
      if (!(await this.requireAdmin(event, "inspect tool audit records"))) {
        return;
      }
      const parsed = this.parseToolAuditArgs(args.slice(1));
      if (parsed.error) {
        await sendReply(this.api, event, parsed.error);
        return;
      }
      const records = this.toolApprovals.listAudit({
        sessionKey: parsed.here ? session.sessionKey : undefined,
        toolName: parsed.toolName,
        decisionCode: parsed.decisionCode,
        limit: parsed.limit,
      });
      await sendReply(
        this.api,
        event,
        records.length > 0
          ? ["Tool audit:", ...records.map(formatToolAuditRecord)].join("\n")
          : "No matching tool audit records.",
      );
      return;
    }
    if (sub === "approve") {
      if (!this.isAdmin(event) || !event.fromUserId) {
        await sendReply(this.api, event, "Only owner/admin roles can approve side-effecting tools.");
        return;
      }
      if (!this.config.tools.enableSideEffectTools) {
        await sendReply(this.api, event, "Side-effecting tools are disabled on this host.");
        return;
      }
      const toolName = normalizeSingleArg(args[1]);
      if (!toolName) {
        await sendReply(this.api, event, "Usage: /tool approve <tool-name> <reason>");
        return;
      }
      let definition: ToolDefinition;
      try {
        definition = this.toolRegistry.resolve(toolName, { allowSideEffects: true });
      } catch (error) {
        await sendReply(this.api, event, error instanceof Error ? error.message : String(error));
        return;
      }
      if (definition.sideEffect === "read_only") {
        await sendReply(this.api, event, `Tool ${definition.name} is read-only and does not need approval.`);
        return;
      }
      const reason = normalizeFreeText(args.slice(2)) || "operator approved";
      const pending = this.toolApprovals.findLatestPendingRequest({
        sessionKey: session.sessionKey,
        toolName: definition.name,
      });
      const approval = this.toolApprovals.approve({
        sessionKey: session.sessionKey,
        toolName: definition.name,
        approvedByUserId: event.fromUserId,
        reason,
        ttlMs: this.config.tools.approvalTtlMs,
        requestFingerprint: pending?.requestFingerprint,
        previewText: pending?.previewText,
      });
      this.toolApprovals.recordAudit({
        sessionKey: session.sessionKey,
        toolName: definition.name,
        sideEffect: definition.sideEffect,
        allowed: true,
        decisionCode: "operator_approved",
        requestedAt: pending?.requestedAt ?? approval.approvedAt,
        decidedAt: approval.approvedAt,
        approvedByUserId: event.fromUserId,
        reason,
        requestFingerprint: pending?.requestFingerprint,
        previewText: pending?.previewText,
      });
      await sendReply(
        this.api,
        event,
        `Approved ${approval.toolName} for this session${
          approval.requestFingerprint ? " and latest requested preview" : ""
        } until ${new Date(approval.expiresAt).toISOString()}.`,
      );
      return;
    }
    if (sub === "revoke") {
      if (!this.isAdmin(event)) {
        await sendReply(this.api, event, "Only owner/admin roles can revoke side-effecting tool approvals.");
        return;
      }
      const toolName = normalizeSingleArg(args[1]);
      if (!toolName) {
        await sendReply(this.api, event, "Usage: /tool revoke <tool-name>");
        return;
      }
      const revoked = this.toolApprovals.revokeActive({
        sessionKey: session.sessionKey,
        toolName,
      });
      if (revoked > 0) {
        let definition: ToolDefinition | undefined;
        try {
          definition = this.toolRegistry.resolve(toolName, { allowSideEffects: true });
        } catch {
          definition = undefined;
        }
        if (definition) {
          const now = Date.now();
          this.toolApprovals.recordAudit({
            sessionKey: session.sessionKey,
            toolName: definition.name,
            sideEffect: definition.sideEffect,
            allowed: false,
            decisionCode: "revoked",
            requestedAt: now,
            decidedAt: now,
          });
        }
      }
      await sendReply(this.api, event, revoked > 0 ? `Revoked ${revoked} approvals.` : "No active approval found.");
      return;
    }
    await sendReply(
      this.api,
      event,
      "Usage: /tool status | /tool audit [limit] [here] [tool:<name>] [code:<decision>] | /tool approve <tool-name> <reason> | /tool revoke <tool-name>",
    );
  }

  private parseToolAuditArgs(args: string[]): {
    limit: number;
    here: boolean;
    toolName?: string;
    decisionCode?: ToolApprovalDecision["code"];
    error?: string;
  } {
    let limit = 10;
    let here = false;
    let toolName: string | undefined;
    let decisionCode: ToolApprovalDecision["code"] | undefined;
    for (const raw of args) {
      const value = raw.trim();
      if (!value) {
        continue;
      }
      if (value === "here") {
        here = true;
        continue;
      }
      if (/^\d+$/.test(value)) {
        limit = Math.min(Math.max(Number(value), 1), 50);
        continue;
      }
      if (value.startsWith("tool:")) {
        toolName = normalizeSingleArg(value.slice("tool:".length));
        if (!toolName) {
          return { limit, here, error: "Usage: /tool audit [limit] [here] [tool:<name>] [code:<decision>]" };
        }
        continue;
      }
      if (value.startsWith("code:")) {
        const candidate = value.slice("code:".length);
        if (!isToolAuditDecisionCode(candidate)) {
          return {
            limit,
            here,
            error: `Unknown decision code ${candidate}. Supported codes: ${TOOL_AUDIT_DECISION_CODES.join(", ")}.`,
          };
        }
        decisionCode = candidate;
        continue;
      }
      return { limit, here, error: "Usage: /tool audit [limit] [here] [tool:<name>] [code:<decision>]" };
    }
    return {
      limit,
      here,
      ...(toolName ? { toolName } : {}),
      ...(decisionCode ? { decisionCode } : {}),
    };
  }

  private formatToolHelp(event: InboundEvent, session: SessionRoute): string {
    const isAdmin = this.isAdmin(event);
    const exposedTools = this.listExposedToolsForSession(event, session);
    const approvals = this.toolApprovals?.listActive(session.sessionKey) ?? [];
    const commands = this.visibleCommandTexts(event, [
      commandHelp("tool", "/tool status - show model-exposed tools, enabled host tools, and active approvals"),
      commandHelp("tool", "/tool help - show this help"),
      commandHelp("tools", "/tools - show this help"),
      ...(isAdmin
        ? [
            commandHelp(
              "tool",
              "/tool approve <tool-name> <reason> - approve one side-effecting tool call for this session",
            ),
            commandHelp("tool", "/tool revoke <tool-name> - revoke active approvals for this session"),
            commandHelp(
              "tool",
              "/tool audit [limit] [here] [tool:<name>] [code:<decision>] - inspect recent tool audit records",
            ),
          ]
        : []),
    ]);
    return [
      "Tool help",
      "",
      formatCommandSection("Commands", commands),
      "",
      exposedTools.length > 0
        ? `Model-exposed tools for this caller:\n${exposedTools.map((tool) => `- ${tool.name}`).join("\n")}`
        : "No model-exposed tools for this caller.",
      "",
      `Side-effect tools: ${this.config.tools.enableSideEffectTools ? "enabled" : "disabled"}`,
      !isAdmin ? "Approvals are admin-only." : undefined,
      approvals.length > 0
        ? `Active approvals:\n${approvals
            .map((approval) => `- ${approval.toolName}, expires ${new Date(approval.expiresAt).toISOString()}`)
            .join("\n")}`
        : "No active approvals.",
    ]
      .filter((section): section is string => Boolean(section))
      .join("\n");
  }
}
