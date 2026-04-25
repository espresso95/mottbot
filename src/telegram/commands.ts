import type { Api } from "grammy";
import type { AgentConfig, AppConfig } from "../app/config.js";
import { importCodexCliAuthProfile } from "../codex/cli-auth-import.js";
import type { AuthProfileStore } from "../codex/auth-store.js";
import { isCodexModelRef, isKnownCodexModelRef, KNOWN_CODEX_MODEL_REFS_TEXT } from "../codex/provider.js";
import type { CodexTokenResolver } from "../codex/token-resolver.js";
import { fetchCodexUsage } from "../codex/usage.js";
import type { CodexUsageSnapshot } from "../codex/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";
import type { UsageBudgetService } from "../runs/usage-budget.js";
import type { ProjectCommandRouter } from "../project-tasks/project-command-router.js";
import type { RouteResolver } from "./route-resolver.js";
import { splitTelegramText } from "./formatting.js";
import type { InboundEvent, ParsedCommand } from "./types.js";
import type { HealthReporter } from "../app/health.js";
import type { ToolApprovalAuditRecord, ToolApprovalDecision, ToolApprovalStore } from "../tools/approval.js";
import type { ToolCallerRole, ToolPolicyEngine } from "../tools/policy.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";
import {
  isMemoryCandidateStatus,
  isMemoryScope,
  resolveMemoryScopeKey,
  type MemoryCandidateStatus,
  type MemoryStore,
  type MemoryScope,
  type SessionMemory,
  type MemoryCandidate,
} from "../sessions/memory-store.js";
import type { SessionRoute } from "../sessions/types.js";
import type { OperatorDiagnostics } from "../app/diagnostics.js";
import type { AttachmentRecord, AttachmentRecordStore } from "../sessions/attachment-store.js";
import {
  formatGithubIssues,
  formatGithubPullRequests,
  formatGithubRepositoryMetadata,
  formatGithubStatusSummary,
  formatGithubWorkflowRuns,
  type GithubReadOperations,
} from "../tools/github-read.js";
import {
  isGovernanceOperatorRole,
  parseChatGovernancePolicy,
  parseTelegramUserRole,
  type ChatGovernancePolicy,
  type GovernanceAuditRecord,
  type StoredChatGovernancePolicy,
  type StoredTelegramUserRole,
  type TelegramGovernanceStore,
  type TelegramUserRole,
} from "./governance.js";

function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  const [head = "", ...rest] = trimmed.split(/\s+/);
  const command = head.replace(/^\//, "").replace(/@.+$/, "").toLowerCase();
  return {
    command,
    args: rest,
    raw: trimmed,
  };
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9:_./-]{1,128}$/;
const MAX_BINDING_NAME_LENGTH = 64;

function normalizeSingleArg(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBindingName(raw: string[]): string {
  return raw.join(" ").replace(/\s+/g, " ").trim() || "here";
}

function validateBindingName(value: string): boolean {
  return value.length <= MAX_BINDING_NAME_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeFreeText(args: string[]): string {
  return args.join(" ").replace(/\s+/g, " ").trim();
}

function formatMemoryRecord(memory: SessionMemory): string {
  const labels = [
    memory.scope,
    memory.source === "auto_summary" ? "auto" : memory.source === "model_candidate" ? "candidate" : "explicit",
    memory.pinned ? "pinned" : undefined,
  ].filter(Boolean);
  return `- ${memory.id.slice(0, 8)} [${labels.join(", ")}]: ${memory.contentText}`;
}

function formatMemoryCandidate(candidate: MemoryCandidate): string {
  const details = [
    `scope=${candidate.scope}`,
    `sensitivity=${candidate.sensitivity}`,
    candidate.reason ? `reason=${candidate.reason}` : undefined,
  ].filter(Boolean);
  return `- ${candidate.id.slice(0, 8)} [${details.join(", ")}]: ${candidate.contentText}`;
}

function parseMemoryScopeArgs(
  session: SessionRoute,
  args: string[],
): { scope: MemoryScope; scopeKey: string; contentArgs: string[] } | { error: string } {
  const first = args[0];
  if (!first?.startsWith("scope:")) {
    return { scope: "session", scopeKey: session.sessionKey, contentArgs: args };
  }
  const parts = first.split(":");
  const scope = parts[1]?.trim().toLowerCase();
  if (!scope || !isMemoryScope(scope)) {
    return { error: "Usage: /remember [scope:session|personal|chat|group|project:<key>] <fact>" };
  }
  const explicitScopeKey = parts.length > 2 ? parts.slice(2).join(":") : undefined;
  const scopeKey = resolveMemoryScopeKey({
    context: session,
    scope,
    explicitScopeKey: scope === "project" ? explicitScopeKey : undefined,
  });
  if (!scopeKey) {
    return { error: `Cannot use ${scope} memory scope in this chat.` };
  }
  return {
    scope,
    scopeKey,
    contentArgs: args.slice(1),
  };
}

function formatReset(resetAt: number | undefined): string {
  return typeof resetAt === "number" ? `, resets ${new Date(resetAt).toISOString()}` : "";
}

function formatUsageSummary(usage: CodexUsageSnapshot): string {
  const windows = usage.windows.map(
    (window) => `${window.label}: ${window.usedPercent}%${formatReset(window.resetAt)}`,
  );
  return [
    ...(usage.plan ? [`Plan: ${usage.plan}`] : []),
    ...(windows.length > 0 ? windows : ["No usage windows reported"]),
  ].join("; ");
}

function formatCommandSection(title: string, commands: string[]): string | undefined {
  if (commands.length === 0) {
    return undefined;
  }
  return [title, ...commands.map((command) => `- ${command}`)].join("\n");
}

type CommandHelpEntry = {
  commands: readonly string[];
  text: string;
};

type CommandVisibility =
  | { allowed: true }
  | {
      allowed: false;
      reason: "chat_not_allowed" | "role_not_allowed" | "command_not_allowed" | "group_policy_required";
    };

function commandHelp(commands: string | readonly string[], text: string): CommandHelpEntry {
  return {
    commands: typeof commands === "string" ? [commands] : commands,
    text,
  };
}

function formatAttachmentRecord(record: AttachmentRecord): string {
  const name = record.fileName?.split(/[\\/]/).at(-1)?.replace(/\s+/g, " ").trim() || record.kind;
  const extraction = [
    record.extractionKind,
    record.extractionStatus,
    record.extractionReason,
    record.language ? `lang=${record.language}` : undefined,
    record.promptTextChars !== undefined ? `prompt=${record.promptTextChars}` : undefined,
    record.extractionTruncated ? "truncated" : undefined,
  ].filter(Boolean);
  const details = [
    record.mimeType,
    record.fileSize !== undefined ? `${record.fileSize} bytes` : undefined,
    record.ingestionStatus,
    record.ingestionReason,
    extraction.length > 0 ? `extraction=${extraction.join("/")}` : undefined,
  ].filter(Boolean);
  return `- ${record.id.slice(0, 8)} ${name}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function formatRoleRecord(record: StoredTelegramUserRole): string {
  const source = record.source === "config" ? "config" : "database";
  const details = [
    source,
    record.grantedByUserId ? `by=${record.grantedByUserId}` : undefined,
    record.reason ? `reason=${truncateSingleLine(record.reason, 80)}` : undefined,
  ].filter(Boolean);
  return `- ${record.userId}: ${record.role}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

function formatChatPolicy(record: StoredChatGovernancePolicy | undefined, chatId: string): string {
  if (!record) {
    return `No chat policy set for ${chatId}.`;
  }
  return [
    `Chat policy for ${record.chatId}:`,
    JSON.stringify(record.policy, null, 2),
    `Updated: ${new Date(record.updatedAt).toISOString()}${record.updatedByUserId ? ` by ${record.updatedByUserId}` : ""}`,
  ].join("\n");
}

function formatGovernanceAuditRecord(record: GovernanceAuditRecord): string {
  const at = new Date(record.createdAt).toISOString();
  const details = [
    record.actorUserId ? `actor=${record.actorUserId}` : undefined,
    record.targetUserId ? `target=${record.targetUserId}` : undefined,
    record.chatId ? `chat=${record.chatId}` : undefined,
    record.role ? `role=${record.role}` : undefined,
    record.previousRole ? `previous=${record.previousRole}` : undefined,
    record.reason ? `reason=${truncateSingleLine(record.reason, 80)}` : undefined,
  ].filter(Boolean);
  return `- ${at} ${record.action}${details.length > 0 ? ` ${details.join(" ")}` : ""}`;
}

const TOOL_AUDIT_DECISION_CODES: readonly ToolApprovalDecision["code"][] = [
  "read_only",
  "policy_allowed",
  "policy_missing",
  "role_denied",
  "chat_denied",
  "approval_required",
  "approval_expired",
  "approval_mismatch",
  "approved",
  "operator_approved",
  "revoked",
];

function isToolAuditDecisionCode(value: string): value is ToolApprovalDecision["code"] {
  return TOOL_AUDIT_DECISION_CODES.includes(value as ToolApprovalDecision["code"]);
}

function truncateSingleLine(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatToolAuditRecord(record: ToolApprovalAuditRecord): string {
  const at = new Date(record.decidedAt).toISOString();
  const scope = [
    record.sessionKey ? `session=${record.sessionKey}` : undefined,
    record.runId ? `run=${record.runId.slice(0, 8)}` : undefined,
    record.approvedByUserId ? `by=${record.approvedByUserId}` : undefined,
    record.requestFingerprint ? `request=${record.requestFingerprint.slice(0, 12)}` : undefined,
  ].filter(Boolean);
  const preview = record.previewText ? ` preview="${truncateSingleLine(record.previewText, 120)}"` : "";
  return `- ${at} ${record.toolName} ${record.allowed ? "allowed" : "denied"}:${record.decisionCode} (${record.sideEffect})${
    scope.length > 0 ? ` ${scope.join(" ")}` : ""
  }${preview}`;
}

function formatAgentLine(agent: AgentConfig, params: { currentId?: string; defaultId: string }): string {
  const labels = [
    agent.id === params.defaultId ? "default" : undefined,
    agent.id === params.currentId ? "current" : undefined,
    agent.fastMode ? "fast" : undefined,
    agent.toolNames && agent.toolNames.length > 0 ? `tools=${agent.toolNames.length}` : undefined,
  ].filter(Boolean);
  const display = agent.displayName ? ` (${agent.displayName})` : "";
  return `- ${agent.id}${display}${labels.length > 0 ? ` [${labels.join(", ")}]` : ""}: ${agent.modelRef}, ${agent.profileId}`;
}

function formatAgentDetails(agent: AgentConfig): string {
  return [
    `Agent: ${agent.id}${agent.displayName ? ` (${agent.displayName})` : ""}`,
    `Model: ${agent.modelRef}`,
    `Profile: ${agent.profileId}`,
    `Fast mode: ${agent.fastMode ? "on" : "off"}`,
    `System prompt: ${agent.systemPrompt ? "configured" : "not set"}`,
    `Tool allow-list: ${agent.toolNames && agent.toolNames.length > 0 ? agent.toolNames.join(", ") : "all policy-allowed tools"}`,
    `Tool policy overrides: ${agent.toolPolicies ? Object.keys(agent.toolPolicies).join(", ") || "none" : "none"}`,
    `Max concurrent runs: ${agent.maxConcurrentRuns ?? "unlimited"}`,
    `Max queued runs: ${agent.maxQueuedRuns ?? "unlimited"}`,
  ].join("\n");
}

async function sendReply(api: Api, event: InboundEvent, text: string): Promise<void> {
  for (const chunk of splitTelegramText(text)) {
    await api.sendMessage(event.chatId, chunk, {
      ...(typeof event.threadId === "number" ? { message_thread_id: event.threadId } : {}),
      reply_parameters: { message_id: event.messageId },
    });
  }
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
        await this.handleRunsCommand(event, session, parsed.args);
        return true;
      }
      case "debug": {
        await this.handleDebugCommand(event, session, parsed.args);
        return true;
      }
      case "github":
      case "gh": {
        await this.handleGithubCommand(event, parsed.args);
        return true;
      }
      case "users": {
        await this.handleUsersCommand(event, parsed.args);
        return true;
      }
      case "remember": {
        if (!this.memories) {
          await sendReply(this.api, event, "Memory is not available.");
          return true;
        }
        const scoped = parseMemoryScopeArgs(session, parsed.args);
        if ("error" in scoped) {
          await sendReply(this.api, event, scoped.error);
          return true;
        }
        if (this.governance && !this.governance.isMemoryScopeAllowed({ chatId: event.chatId, scope: scoped.scope })) {
          await sendReply(this.api, event, `Memory scope ${scoped.scope} is not allowed in this chat.`);
          return true;
        }
        const contentText = normalizeFreeText(scoped.contentArgs);
        if (!contentText) {
          await sendReply(this.api, event, "Usage: /remember [scope:session|personal|chat|group|project:<key>] <fact>");
          return true;
        }
        try {
          const memory = this.memories.add({
            sessionKey: session.sessionKey,
            contentText,
            scope: scoped.scope,
            scopeKey: scoped.scopeKey,
          });
          await sendReply(this.api, event, `Remembered ${memory.id.slice(0, 8)} for ${memory.scope} scope.`);
        } catch (error) {
          await sendReply(this.api, event, error instanceof Error ? error.message : String(error));
        }
        return true;
      }
      case "memory": {
        if (!this.memories) {
          await sendReply(this.api, event, "Memory is not available.");
          return true;
        }
        await this.handleMemoryCommand(event, session, parsed.args);
        return true;
      }
      case "forget": {
        if (!this.memories) {
          await sendReply(this.api, event, "Memory is not available.");
          return true;
        }
        const target = normalizeSingleArg(parsed.args[0]);
        if (!target) {
          await sendReply(this.api, event, "Usage: /forget <memory-id-prefix|all>");
          return true;
        }
        if (target === "all") {
          const removed = this.memories.clear(session.sessionKey);
          await sendReply(this.api, event, `Forgot ${removed} memories.`);
          return true;
        }
        if (target === "auto") {
          const removed = this.memories.clear(session.sessionKey, "auto_summary");
          await sendReply(this.api, event, `Forgot ${removed} automatic summaries.`);
          return true;
        }
        const removed = this.memories.removeForScopeContext(session, target);
        await sendReply(this.api, event, removed ? "Memory forgotten." : "No matching memory found.");
        return true;
      }
      case "files": {
        await this.handleFilesCommand(event, session, parsed.args);
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
        const sub = parsed.args[0]?.toLowerCase();
        if (sub === "status") {
          const profiles = this.authProfiles.list();
          await sendReply(
            this.api,
            event,
            profiles.length > 0
              ? profiles
                  .map(
                    (profile) => `${profile.profileId}: ${profile.source}${profile.email ? ` (${profile.email})` : ""}`,
                  )
                  .join("\n")
              : "No auth profiles configured.",
          );
          return true;
        }
        if (sub === "import-cli") {
          const result = importCodexCliAuthProfile({
            store: this.authProfiles,
            profileId: this.config.auth.defaultProfile,
          });
          await sendReply(
            this.api,
            event,
            result.imported
              ? `Imported Codex CLI credentials into ${result.profileId}.`
              : "No Codex CLI ChatGPT auth.json was found.",
          );
          return true;
        }
        if (sub === "login") {
          await sendReply(this.api, event, "Run `pnpm auth:login` on the host machine to complete local OAuth login.");
          return true;
        }
        await sendReply(this.api, event, "Usage: /auth status | /auth import-cli | /auth login");
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
          commandHelp("project", "/project start|status|tail|cancel|publish|approve - run long project tasks"),
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
      const limit = this.parseBoundedLimit(args[1], 10);
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

  private parseBoundedLimit(value: string | undefined, fallback: number): number {
    const parsed = Number(value ?? fallback);
    return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 50) : fallback;
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

  private async handleMemoryCommand(event: InboundEvent, session: SessionRoute, args: string[]): Promise<void> {
    const memories = this.memories;
    if (!memories) {
      await sendReply(this.api, event, "Memory is not available.");
      return;
    }
    const sub = args[0]?.toLowerCase();
    if (!sub || sub === "list") {
      const records = memories.listForScopeContext(session);
      await sendReply(
        this.api,
        event,
        records.length > 0
          ? ["Approved memory:", ...records.map(formatMemoryRecord)].join("\n")
          : "No approved memory.",
      );
      return;
    }
    if (sub === "candidates") {
      const requestedStatus = args[1]?.toLowerCase();
      const status: MemoryCandidateStatus | "all" =
        requestedStatus === "all"
          ? "all"
          : requestedStatus && isMemoryCandidateStatus(requestedStatus)
            ? requestedStatus
            : "pending";
      const candidates = memories.listCandidates(session.sessionKey, status);
      await sendReply(
        this.api,
        event,
        candidates.length > 0
          ? [`Memory candidates (${status}):`, ...candidates.map(formatMemoryCandidate)].join("\n")
          : `No ${status} memory candidates.`,
      );
      return;
    }
    if (sub === "accept") {
      const prefix = normalizeSingleArg(args[1]);
      if (!prefix) {
        await sendReply(this.api, event, "Usage: /memory accept <candidate-id-prefix>");
        return;
      }
      const candidate = memories
        .listCandidates(session.sessionKey, "pending", 50)
        .filter((record) => record.id.startsWith(prefix));
      if (
        candidate.length === 1 &&
        candidate[0] &&
        this.governance &&
        !this.governance.isMemoryScopeAllowed({ chatId: event.chatId, scope: candidate[0].scope })
      ) {
        await sendReply(this.api, event, `Memory scope ${candidate[0].scope} is not allowed in this chat.`);
        return;
      }
      const accepted = memories.acceptCandidate({
        sessionKey: session.sessionKey,
        idPrefix: prefix,
        decidedByUserId: event.fromUserId,
      });
      await sendReply(
        this.api,
        event,
        accepted
          ? `Accepted ${accepted.memory.id.slice(0, 8)} for ${accepted.memory.scope} memory.`
          : "No pending candidate found.",
      );
      return;
    }
    if (sub === "reject") {
      const prefix = normalizeSingleArg(args[1]);
      if (!prefix) {
        await sendReply(this.api, event, "Usage: /memory reject <candidate-id-prefix>");
        return;
      }
      const rejected = memories.rejectCandidate(session.sessionKey, prefix, event.fromUserId);
      await sendReply(this.api, event, rejected ? "Candidate rejected." : "No pending candidate found.");
      return;
    }
    if (sub === "edit") {
      const prefix = normalizeSingleArg(args[1]);
      const contentText = normalizeFreeText(args.slice(2));
      if (!prefix || !contentText) {
        await sendReply(this.api, event, "Usage: /memory edit <candidate-id-prefix> <replacement fact>");
        return;
      }
      const updated = memories.updateCandidate(session.sessionKey, prefix, contentText);
      await sendReply(
        this.api,
        event,
        updated ? `Candidate ${updated.id.slice(0, 8)} updated.` : "No pending candidate found.",
      );
      return;
    }
    if (sub === "pin" || sub === "unpin") {
      const prefix = normalizeSingleArg(args[1]);
      if (!prefix) {
        await sendReply(this.api, event, `Usage: /memory ${sub} <memory-id-prefix>`);
        return;
      }
      const pinned = memories.pinForScopeContext(session, prefix, sub === "pin");
      await sendReply(
        this.api,
        event,
        pinned ? `Memory ${sub === "pin" ? "pinned" : "unpinned"}.` : "No matching memory found.",
      );
      return;
    }
    if (sub === "archive") {
      const targetType = args[1]?.toLowerCase();
      if (targetType === "candidate") {
        const prefix = normalizeSingleArg(args[2]);
        if (!prefix) {
          await sendReply(this.api, event, "Usage: /memory archive candidate <candidate-id-prefix>");
          return;
        }
        const archived = memories.archiveCandidate(session.sessionKey, prefix, event.fromUserId);
        await sendReply(this.api, event, archived ? "Candidate archived." : "No pending candidate found.");
        return;
      }
      const prefix = normalizeSingleArg(args[1]);
      if (!prefix) {
        await sendReply(this.api, event, "Usage: /memory archive <memory-id-prefix>");
        return;
      }
      const archived = memories.archiveForScopeContext(session, prefix);
      await sendReply(this.api, event, archived ? "Memory archived." : "No matching memory found.");
      return;
    }
    if (sub === "clear" && args[1]?.toLowerCase() === "candidates") {
      const removed = memories.clearCandidates(session.sessionKey);
      await sendReply(this.api, event, `Cleared ${removed} pending memory candidates.`);
      return;
    }
    await sendReply(
      this.api,
      event,
      "Usage: /memory [list] | candidates [status|all] | accept <id> | reject <id> | edit <id> <text> | pin <id> | unpin <id> | archive <id> | archive candidate <id> | clear candidates",
    );
  }

  private async handleRunsCommand(event: InboundEvent, session: SessionRoute, args: string[]): Promise<void> {
    if (!(await this.requireAdmin(event, "inspect runs"))) {
      return;
    }
    if (!this.diagnostics) {
      await sendReply(this.api, event, "Diagnostics are not available.");
      return;
    }
    const limit = Number(args[0] ?? 10);
    await sendReply(
      this.api,
      event,
      this.diagnostics.recentRunsText({
        limit: Number.isInteger(limit) ? limit : 10,
        sessionKey: args.includes("here") ? session.sessionKey : undefined,
      }),
    );
  }

  private async handleFilesCommand(event: InboundEvent, session: SessionRoute, args: string[]): Promise<void> {
    if (!this.attachments) {
      await sendReply(this.api, event, "File metadata is not available.");
      return;
    }
    const sub = args[0]?.toLowerCase();
    if (!sub || sub === "list") {
      const limit = Number(args[1] ?? 10);
      const records = this.attachments.listRecent(session.sessionKey, Number.isInteger(limit) ? limit : 10);
      await sendReply(
        this.api,
        event,
        records.length > 0
          ? ["Recent files:", ...records.map(formatAttachmentRecord)].join("\n")
          : "No files recorded for this session.",
      );
      return;
    }
    if (sub === "clear" || (sub === "forget" && args[1]?.toLowerCase() === "all")) {
      const removed = this.attachments.clearSession(session.sessionKey);
      const transcriptRows = this.transcripts.removeAttachmentMetadata({ sessionKey: session.sessionKey });
      await sendReply(
        this.api,
        event,
        `Forgot ${removed} file records and updated ${transcriptRows} transcript messages.`,
      );
      return;
    }
    if (sub === "forget") {
      const prefix = normalizeSingleArg(args[1]);
      if (!prefix) {
        await sendReply(this.api, event, "Usage: /files forget <file-id-prefix|all>");
        return;
      }
      const matches = this.attachments.findByIdPrefix(session.sessionKey, prefix);
      if (matches.length === 0) {
        await sendReply(this.api, event, "No matching file record found.");
        return;
      }
      if (matches.length > 1) {
        await sendReply(this.api, event, "File ID prefix is ambiguous. Use more characters from /files.");
        return;
      }
      const record = matches[0]!;
      const removed = this.attachments.remove(session.sessionKey, record.id);
      const transcriptRows = this.transcripts.removeAttachmentMetadata({
        sessionKey: session.sessionKey,
        runId: record.runId,
        recordId: record.id,
      });
      await sendReply(
        this.api,
        event,
        removed > 0
          ? `Forgot file ${record.id.slice(0, 8)} and updated ${transcriptRows} transcript messages.`
          : "No matching file record found.",
      );
      return;
    }
    await sendReply(
      this.api,
      event,
      "Usage: /files [list [limit]] | /files forget <file-id-prefix|all> | /files clear",
    );
  }

  private async handleDebugCommand(event: InboundEvent, session: SessionRoute, args: string[]): Promise<void> {
    if (!(await this.requireAdmin(event, "inspect diagnostics"))) {
      return;
    }
    if (!this.diagnostics) {
      await sendReply(this.api, event, "Diagnostics are not available.");
      return;
    }
    const sub = args[0]?.toLowerCase() ?? "summary";
    if (sub === "summary") {
      await sendReply(
        this.api,
        event,
        [
          this.health.formatForText(),
          "",
          this.diagnostics.configText(),
          "",
          this.diagnostics.recentRunsText({ limit: 5, sessionKey: session.sessionKey }),
        ].join("\n"),
      );
      return;
    }
    if (sub === "service") {
      await sendReply(this.api, event, this.diagnostics.serviceStatus());
      return;
    }
    if (sub === "runs") {
      const limit = Number(args[1] ?? 10);
      await sendReply(
        this.api,
        event,
        this.diagnostics.recentRunsText({
          limit: Number.isInteger(limit) ? limit : 10,
          sessionKey: args.includes("here") ? session.sessionKey : undefined,
        }),
      );
      return;
    }
    if (sub === "agents") {
      await sendReply(this.api, event, this.diagnostics.agentDiagnosticsText());
      return;
    }
    if (sub === "errors") {
      const limit = Number(args[1] ?? 10);
      await sendReply(this.api, event, this.diagnostics.recentErrorsText(Number.isInteger(limit) ? limit : 10));
      return;
    }
    if (sub === "logs") {
      const stream = args[1] === "stdout" || args[1] === "stderr" || args[1] === "both" ? args[1] : "both";
      const rawLines = Number(stream === args[1] ? (args[2] ?? 40) : (args[1] ?? 40));
      await sendReply(
        this.api,
        event,
        this.diagnostics.recentLogsText({
          stream,
          lines: Number.isInteger(rawLines) ? rawLines : 40,
        }),
      );
      return;
    }
    if (sub === "config") {
      await sendReply(this.api, event, this.diagnostics.configText());
      return;
    }
    await sendReply(
      this.api,
      event,
      "Usage: /debug [summary|service|runs [limit] [here]|agents|errors [limit]|logs [stdout|stderr|both] [lines]|config]",
    );
  }

  private parseGithubArgs(args: string[], defaultLimit = 5): { limit: number; repository?: string } {
    let limit = defaultLimit;
    let repository: string | undefined;
    for (const raw of args) {
      const value = raw.trim();
      if (!value) {
        continue;
      }
      if (/^\d+$/.test(value)) {
        limit = Math.min(Math.max(Number(value), 1), 50);
        continue;
      }
      repository = value.startsWith("repo:") ? value.slice("repo:".length) : value;
    }
    return {
      limit,
      ...(repository ? { repository } : {}),
    };
  }

  private async handleGithubCommand(event: InboundEvent, args: string[]): Promise<void> {
    if (!(await this.requireAdmin(event, "inspect GitHub"))) {
      return;
    }
    if (!this.github) {
      await sendReply(this.api, event, "GitHub integration is not available.");
      return;
    }
    const requestedSub = args[0]?.toLowerCase();
    const knownSubcommands = new Set([
      "help",
      "status",
      "repo",
      "prs",
      "pulls",
      "issues",
      "runs",
      "ci",
      "failures",
      "failed",
    ]);
    const sub = requestedSub && knownSubcommands.has(requestedSub) ? requestedSub : "status";
    const rest = sub === "status" && requestedSub && !knownSubcommands.has(requestedSub) ? args : args.slice(1);
    const parsed = this.parseGithubArgs(rest);
    try {
      if (sub === "help") {
        await sendReply(
          this.api,
          event,
          [
            "GitHub commands",
            "- /github status [repository]",
            "- /github repo [repository]",
            "- /github prs [limit] [repository]",
            "- /github issues [limit] [repository]",
            "- /github runs [limit] [repository]",
            "- /github failures [limit] [repository]",
          ].join("\n"),
        );
        return;
      }
      if (sub === "status") {
        const [metadata, pullRequests, issues, runs] = await Promise.all([
          this.github.repository({ repository: parsed.repository }),
          this.github.openPullRequests({ repository: parsed.repository, limit: parsed.limit }),
          this.github.recentIssues({ repository: parsed.repository, limit: parsed.limit }),
          this.github.ciStatus({ repository: parsed.repository, limit: parsed.limit }),
        ]);
        await sendReply(
          this.api,
          event,
          formatGithubStatusSummary({
            metadata,
            pullRequests: pullRequests.pullRequests,
            pullRequestsTruncated: pullRequests.truncated,
            issues: issues.issues,
            issuesTruncated: issues.truncated,
            runs: runs.runs,
          }),
        );
        return;
      }
      if (sub === "repo") {
        await sendReply(this.api, event, formatGithubRepositoryMetadata(await this.github.repository(parsed)));
        return;
      }
      if (sub === "prs" || sub === "pulls") {
        const result = await this.github.openPullRequests(parsed);
        await sendReply(this.api, event, formatGithubPullRequests(result.repository, result.pullRequests));
        return;
      }
      if (sub === "issues") {
        const result = await this.github.recentIssues(parsed);
        await sendReply(this.api, event, formatGithubIssues(result.repository, result.issues));
        return;
      }
      if (sub === "runs" || sub === "ci") {
        const result = await this.github.ciStatus(parsed);
        await sendReply(
          this.api,
          event,
          formatGithubWorkflowRuns({ repository: result.repository, title: "Recent workflow runs", runs: result.runs }),
        );
        return;
      }
      if (sub === "failures" || sub === "failed") {
        const result = await this.github.recentWorkflowFailures(parsed);
        await sendReply(
          this.api,
          event,
          formatGithubWorkflowRuns({
            repository: result.repository,
            title: "Recent failed workflow runs",
            runs: result.runs,
          }),
        );
        return;
      }
    } catch (error) {
      await sendReply(this.api, event, error instanceof Error ? error.message : String(error));
      return;
    }
    await sendReply(this.api, event, "Usage: /github status|repo|prs|issues|runs|failures [limit] [repository]");
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
