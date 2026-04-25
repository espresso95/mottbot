import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import type {
  StoredToolApproval,
  ToolApprovalAuditRecord,
  ToolApprovalDecision,
  ToolApprovalStore,
} from "../tools/approval.js";
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
import type { InboundEvent, TelegramCallbackEvent } from "./types.js";

const TELEGRAM_TEXT_MAX_CHARS = 4096;

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

/** Dependencies needed by Telegram tool approval callback buttons. */
export type ToolApprovalCallbackDependencies = {
  api: Api;
  event: TelegramCallbackEvent;
  session: SessionRoute;
  toolsConfig: AppConfig["tools"];
  isAdmin: boolean;
  toolRegistry?: ToolRegistry;
  toolApprovals?: ToolApprovalStore;
  continueAfterApproval?: (params: {
    event: InboundEvent;
    session: SessionRoute;
    pending: ToolApprovalAuditRecord;
    approval: StoredToolApproval;
  }) => Promise<void>;
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

function callbackNotice(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function answerCallback(api: Api, event: TelegramCallbackEvent, text: string, showAlert = false): Promise<void> {
  await api.answerCallbackQuery(event.callbackQueryId, {
    text: callbackNotice(text),
    show_alert: showAlert,
  });
}

async function clearCallbackKeyboard(api: Api, event: TelegramCallbackEvent): Promise<void> {
  try {
    await api.editMessageReplyMarkup(event.chatId, event.messageId);
  } catch {
    // The approval decision has already been recorded; stale keyboard cleanup is best effort.
  }
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

async function editCallbackStatus(api: Api, event: TelegramCallbackEvent, status: string): Promise<void> {
  try {
    await api.editMessageText(event.chatId, event.messageId, callbackStatusText(event, status));
  } catch {
    // Some Telegram messages cannot be edited; keyboard cleanup below still prevents stale taps.
  }
  await clearCallbackKeyboard(api, event);
}

function inboundEventFromCallback(event: TelegramCallbackEvent, text: string): InboundEvent {
  return {
    updateId: event.updateId,
    chatId: event.chatId,
    chatType: event.chatType,
    messageId: event.messageId,
    ...(typeof event.threadId === "number" ? { threadId: event.threadId } : {}),
    ...(event.fromUserId ? { fromUserId: event.fromUserId } : {}),
    ...(event.fromUsername ? { fromUsername: event.fromUsername } : {}),
    text,
    entities: [],
    attachments: [],
    mentionsBot: false,
    isCommand: false,
    arrivedAt: event.arrivedAt,
  };
}

function continuationPrompt(params: { pending: ToolApprovalAuditRecord; approval: StoredToolApproval }): string {
  return [
    `Tool approval granted for ${params.approval.toolName}.`,
    params.pending.previewText ? `Approved preview:\n${params.pending.previewText}` : undefined,
    "Continue the previous user request now. Retry the approved tool call with the same intended arguments. If the approval no longer matches, explain what changed.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function existingRequestDecisionMessage(record: ToolApprovalAuditRecord): string | undefined {
  if (record.decisionCode === "operator_approved") {
    return "This request was already approved.";
  }
  if (record.decisionCode === "operator_denied") {
    return "This request was already denied.";
  }
  if (record.decisionCode === "approval_expired") {
    return "This approval request has already expired.";
  }
  return undefined;
}

function pendingRequestExpired(params: { pending: ToolApprovalAuditRecord; ttlMs: number; now: number }): boolean {
  return params.pending.requestedAt + params.ttlMs <= params.now;
}

async function recordExpiredPendingRequest(params: {
  api: Api;
  event: TelegramCallbackEvent;
  session: SessionRoute;
  toolApprovals: ToolApprovalStore;
  definition: ToolDefinition;
  pending: ToolApprovalAuditRecord;
}): Promise<void> {
  const message = `Approval request for ${params.definition.name} expired. Ask the model to retry the action.`;
  params.toolApprovals.recordAudit({
    sessionKey: params.session.sessionKey,
    ...(params.pending.runId ? { runId: params.pending.runId } : {}),
    toolName: params.definition.name,
    sideEffect: params.definition.sideEffect,
    allowed: false,
    decisionCode: "approval_expired",
    requestedAt: params.pending.requestedAt,
    decidedAt: params.event.arrivedAt,
    ...(params.event.fromUserId ? { approvedByUserId: params.event.fromUserId } : {}),
    reason: "telegram button expired",
    requestFingerprint: params.pending.requestFingerprint,
    previewText: params.pending.previewText,
  });
  await editCallbackStatus(params.api, params.event, message);
  await answerCallback(params.api, params.event, message, true);
  await sendReply(params.api, params.event, message);
}

async function resolvePendingToolCallback(
  params: ToolApprovalCallbackDependencies,
  auditId: string,
): Promise<
  | {
      pending: ToolApprovalAuditRecord;
      definition: ToolDefinition;
      previousDecision?: ToolApprovalAuditRecord;
    }
  | undefined
> {
  const { api, event, session, toolApprovals, toolRegistry } = params;
  if (!toolRegistry || !toolApprovals) {
    await answerCallback(api, event, "Tool approvals are not available.", true);
    await sendReply(api, event, "Tool approvals are not available.");
    return undefined;
  }

  const pending = toolApprovals.findPendingRequestById({
    id: auditId,
    sessionKey: session.sessionKey,
  });
  if (!pending) {
    const message = "No matching pending approval request found for this session.";
    await answerCallback(api, event, message, true);
    await sendReply(api, event, message);
    return undefined;
  }

  let definition: ToolDefinition;
  try {
    definition = toolRegistry.resolve(pending.toolName, { allowSideEffects: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await answerCallback(api, event, message, true);
    await sendReply(api, event, message);
    return undefined;
  }
  if (definition.sideEffect === "read_only") {
    const message = `Tool ${definition.name} is read-only and does not need approval.`;
    await answerCallback(api, event, message, true);
    await sendReply(api, event, message);
    return undefined;
  }

  const previousDecision = pending.requestFingerprint
    ? toolApprovals.findLatestOperatorDecisionForRequest({
        sessionKey: session.sessionKey,
        toolName: definition.name,
        requestFingerprint: pending.requestFingerprint,
        ...(pending.runId ? { runId: pending.runId } : {}),
      })
    : undefined;
  return {
    pending,
    definition,
    ...(previousDecision ? { previousDecision } : {}),
  };
}

/** Handles inline approval button callbacks for pending side-effecting tool requests. */
export async function handleToolApprovalCallback(
  params: ToolApprovalCallbackDependencies,
  auditId: string,
): Promise<void> {
  const { api, event, session, toolApprovals, toolsConfig, isAdmin, continueAfterApproval } = params;
  if (!isAdmin || !event.fromUserId) {
    const message = "Only owner/admin roles can approve side-effecting tools.";
    await answerCallback(api, event, message, true);
    await sendReply(api, event, message);
    return;
  }
  if (!toolsConfig.enableSideEffectTools) {
    await answerCallback(api, event, "Side-effecting tools are disabled on this host.", true);
    await sendReply(api, event, "Side-effecting tools are disabled on this host.");
    return;
  }

  const resolved = await resolvePendingToolCallback(params, auditId);
  if (!resolved || !toolApprovals) {
    return;
  }
  const { pending, definition, previousDecision } = resolved;
  const previousDecisionMessage = previousDecision ? existingRequestDecisionMessage(previousDecision) : undefined;
  if (previousDecisionMessage) {
    await editCallbackStatus(api, event, previousDecisionMessage);
    await answerCallback(api, event, previousDecisionMessage);
    await sendReply(api, event, previousDecisionMessage);
    return;
  }
  if (pendingRequestExpired({ pending, ttlMs: toolsConfig.approvalTtlMs, now: event.arrivedAt })) {
    await recordExpiredPendingRequest({ api, event, session, toolApprovals, definition, pending });
    return;
  }

  const activeApproval = toolApprovals.findActive({
    sessionKey: session.sessionKey,
    toolName: definition.name,
  });
  if (activeApproval && activeApproval.requestFingerprint === pending.requestFingerprint) {
    const message = `Approval for ${definition.name} is already active until ${new Date(
      activeApproval.expiresAt,
    ).toISOString()}.`;
    await editCallbackStatus(api, event, message);
    await answerCallback(api, event, "Already approved.");
    await sendReply(api, event, message);
    return;
  }

  const reason = "telegram button approval";
  const approval = toolApprovals.approve({
    sessionKey: session.sessionKey,
    toolName: definition.name,
    approvedByUserId: event.fromUserId,
    reason,
    ttlMs: toolsConfig.approvalTtlMs,
    requestFingerprint: pending.requestFingerprint,
    previewText: pending.previewText,
  });
  toolApprovals.recordAudit({
    sessionKey: session.sessionKey,
    toolName: definition.name,
    sideEffect: definition.sideEffect,
    allowed: true,
    decisionCode: "operator_approved",
    requestedAt: pending.requestedAt,
    decidedAt: approval.approvedAt,
    approvedByUserId: event.fromUserId,
    reason,
    requestFingerprint: pending.requestFingerprint,
    previewText: pending.previewText,
    ...(pending.runId ? { runId: pending.runId } : {}),
  });
  await editCallbackStatus(api, event, `Approved ${approval.toolName}. Continuing...`);
  await answerCallback(api, event, `Approved ${approval.toolName}. Continuing.`);
  if (!continueAfterApproval) {
    await sendReply(
      api,
      event,
      `Approved ${approval.toolName} for this session and requested preview until ${new Date(
        approval.expiresAt,
      ).toISOString()}.`,
    );
    return;
  }
  try {
    await continueAfterApproval({
      event: inboundEventFromCallback(event, continuationPrompt({ pending, approval })),
      session,
      pending,
      approval,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sendReply(api, event, `Approved ${approval.toolName}, but automatic continuation failed: ${message}`);
  }
}

/** Handles inline deny button callbacks for pending side-effecting tool requests. */
export async function handleToolDenyCallback(params: ToolApprovalCallbackDependencies, auditId: string): Promise<void> {
  const { api, event, session, toolApprovals, toolsConfig, isAdmin } = params;
  if (!isAdmin || !event.fromUserId) {
    const message = "Only owner/admin roles can deny side-effecting tools.";
    await answerCallback(api, event, message, true);
    await sendReply(api, event, message);
    return;
  }
  if (!toolsConfig.enableSideEffectTools) {
    await answerCallback(api, event, "Side-effecting tools are disabled on this host.", true);
    await sendReply(api, event, "Side-effecting tools are disabled on this host.");
    return;
  }

  const resolved = await resolvePendingToolCallback(params, auditId);
  if (!resolved || !toolApprovals) {
    return;
  }
  const { pending, definition, previousDecision } = resolved;
  const previousDecisionMessage = previousDecision ? existingRequestDecisionMessage(previousDecision) : undefined;
  if (previousDecisionMessage) {
    await editCallbackStatus(api, event, previousDecisionMessage);
    await answerCallback(api, event, previousDecisionMessage);
    await sendReply(api, event, previousDecisionMessage);
    return;
  }
  if (pendingRequestExpired({ pending, ttlMs: toolsConfig.approvalTtlMs, now: event.arrivedAt })) {
    await recordExpiredPendingRequest({ api, event, session, toolApprovals, definition, pending });
    return;
  }

  const reason = "telegram button deny";
  toolApprovals.recordAudit({
    sessionKey: session.sessionKey,
    ...(pending.runId ? { runId: pending.runId } : {}),
    toolName: definition.name,
    sideEffect: definition.sideEffect,
    allowed: false,
    decisionCode: "operator_denied",
    requestedAt: pending.requestedAt,
    decidedAt: event.arrivedAt,
    approvedByUserId: event.fromUserId,
    reason,
    requestFingerprint: pending.requestFingerprint,
    previewText: pending.previewText,
  });
  await editCallbackStatus(api, event, `Denied ${definition.name}.`);
  await answerCallback(api, event, `Denied ${definition.name}.`);
  await sendReply(api, event, `Denied ${definition.name}. The pending request will not continue.`);
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
    if (pending && pendingRequestExpired({ pending, ttlMs: toolsConfig.approvalTtlMs, now: event.arrivedAt })) {
      toolApprovals.recordAudit({
        sessionKey: session.sessionKey,
        ...(pending.runId ? { runId: pending.runId } : {}),
        toolName: definition.name,
        sideEffect: definition.sideEffect,
        allowed: false,
        decisionCode: "approval_expired",
        requestedAt: pending.requestedAt,
        decidedAt: event.arrivedAt,
        requestFingerprint: pending.requestFingerprint,
        previewText: pending.previewText,
      });
      await sendReply(api, event, `Latest pending request for ${definition.name} expired. Ask the model to retry.`);
      return;
    }
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
      ...(pending?.runId ? { runId: pending.runId } : {}),
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
