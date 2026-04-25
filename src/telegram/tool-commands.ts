import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import type { ToolApprovalDecision, ToolApprovalStore } from "../tools/approval.js";
import type { ModelToolDeclaration, ToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { SessionRoute } from "../sessions/types.js";
import {
  TOOL_AUDIT_DECISION_CODES,
  commandHelp,
  formatCommandSection,
  formatToolAuditRecord,
  isToolAuditDecisionCode,
  type CommandHelpEntry,
} from "./command-formatters.js";
import { normalizeFreeText, normalizeSingleArg } from "./command-parsing.js";
import { sendReply } from "./command-replies.js";
import type { InboundEvent } from "./types.js";

/** Dependencies needed by the Telegram tool approval command handler. */
export type ToolCommandDependencies = {
  api: Api;
  event: InboundEvent;
  session: SessionRoute;
  args: string[];
  toolsConfig: AppConfig["tools"];
  exposedTools: readonly ModelToolDeclaration[];
  isAdmin: boolean;
  visibleCommandTexts: (entries: readonly CommandHelpEntry[]) => string[];
  toolRegistry?: ToolRegistry;
  toolApprovals?: ToolApprovalStore;
};

/** Parsed filters for /tool audit. */
export type ToolAuditArgs = {
  limit: number;
  here: boolean;
  toolName?: string;
  decisionCode?: ToolApprovalDecision["code"];
  error?: string;
};

/** Parses /tool audit filter arguments. */
export function parseToolAuditArgs(args: string[]): ToolAuditArgs {
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

function formatToolHelp(params: ToolCommandDependencies): string {
  const { isAdmin, exposedTools, session, toolApprovals, toolsConfig, visibleCommandTexts } = params;
  const approvals = toolApprovals?.listActive(session.sessionKey) ?? [];
  const commands = visibleCommandTexts([
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
    `Side-effect tools: ${toolsConfig.enableSideEffectTools ? "enabled" : "disabled"}`,
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

function recordRevocationAudit(params: {
  toolApprovals: ToolApprovalStore;
  toolRegistry: ToolRegistry;
  sessionKey: string;
  toolName: string;
}): void {
  let definition: ToolDefinition | undefined;
  try {
    definition = params.toolRegistry.resolve(params.toolName, { allowSideEffects: true });
  } catch {
    definition = undefined;
  }
  if (!definition) {
    return;
  }
  const now = Date.now();
  params.toolApprovals.recordAudit({
    sessionKey: params.sessionKey,
    toolName: definition.name,
    sideEffect: definition.sideEffect,
    allowed: false,
    decisionCode: "revoked",
    requestedAt: now,
    decidedAt: now,
  });
}

/** Handles /tool and /tools approval, audit, and status subcommands. */
export async function handleToolCommand(params: ToolCommandDependencies): Promise<void> {
  const { api, event, session, args, exposedTools, toolApprovals, toolRegistry, toolsConfig, isAdmin } = params;
  const sub = args[0]?.toLowerCase();
  if (!toolRegistry || !toolApprovals) {
    await sendReply(api, event, "Tool approvals are not available.");
    return;
  }
  if (sub === "help") {
    await sendReply(api, event, formatToolHelp(params));
    return;
  }
  if (!sub || sub === "status") {
    const tools = toolRegistry.listEnabled();
    const approvals = toolApprovals.listActive(session.sessionKey);
    await sendReply(
      api,
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
    if (!isAdmin) {
      await sendReply(api, event, "Only owner/admin roles can inspect tool audit records.");
      return;
    }
    const parsed = parseToolAuditArgs(args.slice(1));
    if (parsed.error) {
      await sendReply(api, event, parsed.error);
      return;
    }
    const records = toolApprovals.listAudit({
      sessionKey: parsed.here ? session.sessionKey : undefined,
      toolName: parsed.toolName,
      decisionCode: parsed.decisionCode,
      limit: parsed.limit,
    });
    await sendReply(
      api,
      event,
      records.length > 0
        ? ["Tool audit:", ...records.map(formatToolAuditRecord)].join("\n")
        : "No matching tool audit records.",
    );
    return;
  }
  if (sub === "approve") {
    if (!isAdmin || !event.fromUserId) {
      await sendReply(api, event, "Only owner/admin roles can approve side-effecting tools.");
      return;
    }
    if (!toolsConfig.enableSideEffectTools) {
      await sendReply(api, event, "Side-effecting tools are disabled on this host.");
      return;
    }
    const toolName = normalizeSingleArg(args[1]);
    if (!toolName) {
      await sendReply(api, event, "Usage: /tool approve <tool-name> <reason>");
      return;
    }
    let definition: ToolDefinition;
    try {
      definition = toolRegistry.resolve(toolName, { allowSideEffects: true });
    } catch (error) {
      await sendReply(api, event, error instanceof Error ? error.message : String(error));
      return;
    }
    if (definition.sideEffect === "read_only") {
      await sendReply(api, event, `Tool ${definition.name} is read-only and does not need approval.`);
      return;
    }
    const reason = normalizeFreeText(args.slice(2)) || "operator approved";
    const pending = toolApprovals.findLatestPendingRequest({
      sessionKey: session.sessionKey,
      toolName: definition.name,
    });
    const approval = toolApprovals.approve({
      sessionKey: session.sessionKey,
      toolName: definition.name,
      approvedByUserId: event.fromUserId,
      reason,
      ttlMs: toolsConfig.approvalTtlMs,
      requestFingerprint: pending?.requestFingerprint,
      previewText: pending?.previewText,
    });
    toolApprovals.recordAudit({
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
      api,
      event,
      `Approved ${approval.toolName} for this session${
        approval.requestFingerprint ? " and latest requested preview" : ""
      } until ${new Date(approval.expiresAt).toISOString()}.`,
    );
    return;
  }
  if (sub === "revoke") {
    if (!isAdmin) {
      await sendReply(api, event, "Only owner/admin roles can revoke side-effecting tool approvals.");
      return;
    }
    const toolName = normalizeSingleArg(args[1]);
    if (!toolName) {
      await sendReply(api, event, "Usage: /tool revoke <tool-name>");
      return;
    }
    const revoked = toolApprovals.revokeActive({
      sessionKey: session.sessionKey,
      toolName,
    });
    if (revoked > 0) {
      recordRevocationAudit({ toolApprovals, toolRegistry, sessionKey: session.sessionKey, toolName });
    }
    await sendReply(api, event, revoked > 0 ? `Revoked ${revoked} approvals.` : "No active approval found.");
    return;
  }
  await sendReply(
    api,
    event,
    "Usage: /tool status | /tool audit [limit] [here] [tool:<name>] [code:<decision>] | /tool approve <tool-name> <reason> | /tool revoke <tool-name>",
  );
}
