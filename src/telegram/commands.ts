import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import { importCodexCliAuthProfile } from "../codex/cli-auth-import.js";
import type { AuthProfileStore } from "../codex/auth-store.js";
import { isKnownCodexModelRef, KNOWN_CODEX_MODEL_REFS_TEXT } from "../codex/provider.js";
import type { CodexTokenResolver } from "../codex/token-resolver.js";
import { fetchCodexUsage } from "../codex/usage.js";
import type { CodexUsageSnapshot } from "../codex/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";
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

async function sendReply(
  api: Api,
  event: InboundEvent,
  text: string,
): Promise<void> {
  for (const chunk of splitTelegramText(text)) {
    await api.sendMessage(event.chatId, chunk, {
      ...(typeof event.threadId === "number" ? { message_thread_id: event.threadId } : {}),
      reply_parameters: { message_id: event.messageId },
    });
  }
}

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
  ) {}

  async maybeHandle(event: InboundEvent): Promise<boolean> {
    const raw = event.text ?? event.caption;
    if (!raw?.trim().startsWith("/")) {
      return false;
    }
    const parsed = parseCommand(raw);
    if (await this.rejectUnauthorizedCommand(event)) {
      return true;
    }
    const session = this.routes.resolve(event);

    switch (parsed.command) {
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
      case "tool": {
        await this.handleToolCommand(event, session, parsed.args);
        return true;
      }
      case "tools": {
        await this.handleToolCommand(event, session, parsed.args.length > 0 ? parsed.args : ["help"]);
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
          await sendReply(this.api, event, "Invalid profile ID. Use 1-128 letters, numbers, dots, slashes, underscores, colons, or hyphens.");
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
                    (profile) =>
                      `${profile.profileId}: ${profile.source}${profile.email ? ` (${profile.email})` : ""}`,
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
          await sendReply(
            this.api,
            event,
            "Run `pnpm auth:login` on the host machine to complete local OAuth login.",
          );
          return true;
        }
        await sendReply(this.api, event, "Usage: /auth status | /auth import-cli | /auth login");
        return true;
      }
      default:
        return false;
    }
  }

  private async rejectUnauthorizedCommand(event: InboundEvent): Promise<boolean> {
    const isAdmin = Boolean(event.fromUserId && this.config.telegram.adminUserIds.includes(event.fromUserId));
    if (
      !isAdmin &&
      this.config.telegram.allowedChatIds.length > 0 &&
      !this.config.telegram.allowedChatIds.includes(event.chatId)
    ) {
      await sendReply(this.api, event, "This chat is not allowed to use this bot.");
      return true;
    }
    if (!isAdmin && event.chatType !== "private") {
      await sendReply(this.api, event, "Only configured admins can run bot commands in groups.");
      return true;
    }
    return false;
  }

  private isAdmin(event: InboundEvent): boolean {
    return Boolean(event.fromUserId && this.config.telegram.adminUserIds.includes(event.fromUserId));
  }

  private callerRole(event: InboundEvent): ToolCallerRole {
    return this.isAdmin(event) ? "admin" : "user";
  }

  private listExposedTools(event: InboundEvent) {
    return this.toolRegistry?.listModelDeclarations({
      includeAdminTools: this.isAdmin(event),
      filter: (definition) =>
        this.toolPolicy?.evaluate(definition, {
          role: this.callerRole(event),
          chatId: event.chatId,
        }).allowed ?? true,
    }) ?? [];
  }

  private async requireAdmin(event: InboundEvent, action: string): Promise<boolean> {
    if (this.isAdmin(event)) {
      return true;
    }
    await sendReply(this.api, event, `Only configured admins can ${action}.`);
    return false;
  }

  private formatHelp(event: InboundEvent, session: SessionRoute): string {
    const isAdmin = this.isAdmin(event);
    const sections = [
      [
        "Mottbot help",
        `Session: ${session.sessionKey}`,
        `Model: ${session.modelRef}`,
        `Profile: ${session.profileId}`,
      ].join("\n"),
      formatCommandSection("Session", [
        "/status - show session, model, profile, and usage",
        "/health - show runtime health",
        "/model <provider/model> - change this session model",
        "/profile [profile-id] - list or select auth profile",
        "/fast on|off - toggle priority service tier",
        "/new or /reset - clear this session transcript",
        "/stop - cancel the active run for this session",
        "/files [forget <id-prefix>|clear] - inspect or forget uploaded file metadata",
        "/bind [name] - keep replies always on for this chat or topic",
        "/unbind - restore default route behavior",
      ]),
      this.memories
        ? formatCommandSection("Memory", [
            "/remember <fact> - store memory for this session",
            "/remember scope:personal <fact> - store user-scoped memory",
            "/memory - list approved memory for this chat",
            "/memory candidates [pending|accepted|rejected|archived|all] - list memory candidates",
            "/memory accept|reject|edit <candidate-id-prefix> - review candidates",
            "/memory pin|unpin|archive <memory-id-prefix> - manage approved memory",
            "/memory clear candidates - clear pending candidates",
            "/forget <memory-id-prefix|all|auto> - remove memory",
          ])
        : undefined,
      this.toolRegistry && this.toolApprovals
        ? formatCommandSection("Tools", [
            "/tool status - show model-exposed tools and approvals",
            "/tool help or /tools - show tool command help",
            ...(isAdmin
              ? [
                  "/tool approve <tool-name> <reason> - approve one side-effecting call",
                  "/tool revoke <tool-name> - revoke active approval",
                  "/tool audit [limit] [here] [tool:<name>] [code:<decision>] - inspect tool audit records",
                ]
              : []),
          ])
        : undefined,
      formatCommandSection("Auth", [
        "/auth status - list configured auth profiles",
        "/auth login - show host-local OAuth command",
        "/auth import-cli - import Codex CLI credentials on this host",
      ]),
      isAdmin && this.diagnostics
        ? formatCommandSection("Admin diagnostics", [
            "/runs [limit] [here] - list recent runs",
            "/debug summary|service|runs|errors|logs|config - inspect diagnostics",
          ])
        : undefined,
      isAdmin && this.github
        ? formatCommandSection("GitHub", [
            "/github status [repository] - show repository, open work, and latest CI",
            "/github prs|issues|runs|failures [limit] [repository] - inspect GitHub read-only state",
          ])
        : undefined,
      this.toolRegistry
        ? [
            "Model-exposed tools for this caller:",
            ...this.listExposedTools(event).map((tool) => `- ${tool.name}`),
          ].join("\n")
        : undefined,
    ].filter((section): section is string => Boolean(section));
    return sections.join("\n\n");
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
        records.length > 0 ? ["Approved memory:", ...records.map(formatMemoryRecord)].join("\n") : "No approved memory.",
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
      await sendReply(this.api, event, `Forgot ${removed} file records and updated ${transcriptRows} transcript messages.`);
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
    await sendReply(this.api, event, "Usage: /files [list [limit]] | /files forget <file-id-prefix|all> | /files clear");
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
    await sendReply(this.api, event, "Usage: /debug [summary|service|runs [limit] [here]|errors [limit]|logs [stdout|stderr|both] [lines]|config]");
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
    const knownSubcommands = new Set(["help", "status", "repo", "prs", "pulls", "issues", "runs", "ci", "failures", "failed"]);
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
          formatGithubWorkflowRuns({ repository: result.repository, title: "Recent failed workflow runs", runs: result.runs }),
        );
        return;
      }
    } catch (error) {
      await sendReply(this.api, event, error instanceof Error ? error.message : String(error));
      return;
    }
    await sendReply(this.api, event, "Usage: /github status|repo|prs|issues|runs|failures [limit] [repository]");
  }

  private async handleToolCommand(
    event: InboundEvent,
    session: SessionRoute,
    args: string[],
  ): Promise<void> {
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
      const exposedTools = this.listExposedTools(event);
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
                .map(
                  (approval) =>
                    `- ${approval.toolName}, expires ${new Date(approval.expiresAt).toISOString()}`,
                )
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
        await sendReply(this.api, event, "Only configured admins can approve side-effecting tools.");
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
        await sendReply(this.api, event, "Only configured admins can revoke side-effecting tool approvals.");
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
    await sendReply(this.api, event, "Usage: /tool status | /tool audit [limit] [here] [tool:<name>] [code:<decision>] | /tool approve <tool-name> <reason> | /tool revoke <tool-name>");
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
    const exposedTools = this.listExposedTools(event);
    const approvals = this.toolApprovals?.listActive(session.sessionKey) ?? [];
    const commands = [
      "/tool status - show model-exposed tools, enabled host tools, and active approvals",
      "/tool help or /tools - show this help",
      ...(isAdmin
        ? [
            "/tool approve <tool-name> <reason> - approve one side-effecting tool call for this session",
            "/tool revoke <tool-name> - revoke active approvals for this session",
            "/tool audit [limit] [here] [tool:<name>] [code:<decision>] - inspect recent tool audit records",
          ]
        : ["Approvals are admin-only."]),
    ];
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
      approvals.length > 0
        ? `Active approvals:\n${approvals
            .map((approval) => `- ${approval.toolName}, expires ${new Date(approval.expiresAt).toISOString()}`)
            .join("\n")}`
        : "No active approvals.",
    ].join("\n");
  }
}
