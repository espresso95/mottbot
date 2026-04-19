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
import type { ToolApprovalStore } from "../tools/approval.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { MemoryStore } from "../sessions/memory-store.js";
import type { SessionRoute } from "../sessions/types.js";

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
      case "remember": {
        if (!this.memories) {
          await sendReply(this.api, event, "Memory is not available.");
          return true;
        }
        const contentText = normalizeFreeText(parsed.args);
        if (!contentText) {
          await sendReply(this.api, event, "Usage: /remember <fact to keep for this session>");
          return true;
        }
        try {
          const memory = this.memories.add({ sessionKey: session.sessionKey, contentText });
          await sendReply(this.api, event, `Remembered ${memory.id.slice(0, 8)}.`);
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
        const memories = this.memories.list(session.sessionKey);
        await sendReply(
          this.api,
          event,
          memories.length > 0
            ? ["Session memory:", ...memories.map((memory) => `- ${memory.id.slice(0, 8)}: ${memory.contentText}`)].join("\n")
            : "No session memory.",
        );
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
        const removed = this.memories.remove(session.sessionKey, target);
        await sendReply(this.api, event, removed ? "Memory forgotten." : "No matching memory found.");
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
    if (!sub || sub === "status") {
      const tools = this.toolRegistry.listEnabled();
      const approvals = this.toolApprovals.listActive(session.sessionKey);
      await sendReply(
        this.api,
        event,
        [
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
      const approval = this.toolApprovals.approve({
        sessionKey: session.sessionKey,
        toolName: definition.name,
        approvedByUserId: event.fromUserId,
        reason,
        ttlMs: this.config.tools.approvalTtlMs,
      });
      await sendReply(
        this.api,
        event,
        `Approved ${approval.toolName} for this session until ${new Date(approval.expiresAt).toISOString()}.`,
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
      await sendReply(this.api, event, revoked > 0 ? `Revoked ${revoked} approvals.` : "No active approval found.");
      return;
    }
    await sendReply(this.api, event, "Usage: /tool status | /tool approve <tool-name> <reason> | /tool revoke <tool-name>");
  }
}
