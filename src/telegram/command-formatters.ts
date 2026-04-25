import type { AgentConfig } from "../app/config.js";
import type { CodexUsageSnapshot } from "../codex/types.js";
import type { AttachmentRecord } from "../sessions/attachment-store.js";
import type { MemoryCandidate, SessionMemory } from "../sessions/memory-store.js";
import type { ToolApprovalAuditRecord, ToolApprovalDecision } from "../tools/approval.js";
import type { GovernanceAuditRecord, StoredChatGovernancePolicy, StoredTelegramUserRole } from "./governance.js";

/** Help entry used to decide command visibility and render Telegram help text. */
export type CommandHelpEntry = {
  commands: readonly string[];
  text: string;
};

/** Tool approval decision codes accepted by Telegram audit filters. */
export const TOOL_AUDIT_DECISION_CODES: readonly ToolApprovalDecision["code"][] = [
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
  "operator_denied",
  "revoked",
];

function formatReset(resetAt: number | undefined): string {
  return typeof resetAt === "number" ? `, resets ${new Date(resetAt).toISOString()}` : "";
}

/** Formats one approved memory record for Telegram command output. */
export function formatMemoryRecord(memory: SessionMemory): string {
  const labels = [
    memory.scope,
    memory.source === "auto_summary" ? "auto" : memory.source === "model_candidate" ? "candidate" : "explicit",
    memory.pinned ? "pinned" : undefined,
  ].filter(Boolean);
  return `- ${memory.id.slice(0, 8)} [${labels.join(", ")}]: ${memory.contentText}`;
}

/** Formats one proposed memory candidate for Telegram command output. */
export function formatMemoryCandidate(candidate: MemoryCandidate): string {
  const details = [
    `scope=${candidate.scope}`,
    `sensitivity=${candidate.sensitivity}`,
    candidate.reason ? `reason=${candidate.reason}` : undefined,
  ].filter(Boolean);
  return `- ${candidate.id.slice(0, 8)} [${details.join(", ")}]: ${candidate.contentText}`;
}

/** Formats Codex usage windows into a compact Telegram status summary. */
export function formatUsageSummary(usage: CodexUsageSnapshot): string {
  const windows = usage.windows.map(
    (window) => `${window.label}: ${window.usedPercent}%${formatReset(window.resetAt)}`,
  );
  return [
    ...(usage.plan ? [`Plan: ${usage.plan}`] : []),
    ...(windows.length > 0 ? windows : ["No usage windows reported"]),
  ].join("; ");
}

/** Formats a titled list of command help lines, omitting empty sections. */
export function formatCommandSection(title: string, commands: string[]): string | undefined {
  if (commands.length === 0) {
    return undefined;
  }
  return [title, ...commands.map((command) => `- ${command}`)].join("\n");
}

/** Creates one command help entry for one command or a command alias set. */
export function commandHelp(commands: string | readonly string[], text: string): CommandHelpEntry {
  return {
    commands: typeof commands === "string" ? [commands] : commands,
    text,
  };
}

/** Formats uploaded-file metadata for Telegram command output. */
export function formatAttachmentRecord(record: AttachmentRecord): string {
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

/** Formats one stored Telegram governance role. */
export function formatRoleRecord(record: StoredTelegramUserRole): string {
  const source = record.source === "config" ? "config" : "database";
  const details = [
    source,
    record.grantedByUserId ? `by=${record.grantedByUserId}` : undefined,
    record.reason ? `reason=${truncateSingleLine(record.reason, 80)}` : undefined,
  ].filter(Boolean);
  return `- ${record.userId}: ${record.role}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
}

/** Formats a Telegram chat governance policy or a clear missing-policy message. */
export function formatChatPolicy(record: StoredChatGovernancePolicy | undefined, chatId: string): string {
  if (!record) {
    return `No chat policy set for ${chatId}.`;
  }
  return [
    `Chat policy for ${record.chatId}:`,
    JSON.stringify(record.policy, null, 2),
    `Updated: ${new Date(record.updatedAt).toISOString()}${record.updatedByUserId ? ` by ${record.updatedByUserId}` : ""}`,
  ].join("\n");
}

/** Formats one Telegram governance audit record. */
export function formatGovernanceAuditRecord(record: GovernanceAuditRecord): string {
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

/** Checks whether a string is a supported tool audit decision code. */
export function isToolAuditDecisionCode(value: string): value is ToolApprovalDecision["code"] {
  return TOOL_AUDIT_DECISION_CODES.includes(value as ToolApprovalDecision["code"]);
}

/** Truncates a value to a single line for compact Telegram command output. */
function truncateSingleLine(value: string, maxChars: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/** Formats one tool approval audit record. */
export function formatToolAuditRecord(record: ToolApprovalAuditRecord): string {
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

/** Formats one configured agent for Telegram list output. */
export function formatAgentLine(agent: AgentConfig, params: { currentId?: string; defaultId: string }): string {
  const labels = [
    agent.id === params.defaultId ? "default" : undefined,
    agent.id === params.currentId ? "current" : undefined,
    agent.fastMode ? "fast" : undefined,
    agent.toolNames && agent.toolNames.length > 0 ? `tools=${agent.toolNames.length}` : undefined,
  ].filter(Boolean);
  const display = agent.displayName ? ` (${agent.displayName})` : "";
  return `- ${agent.id}${display}${labels.length > 0 ? ` [${labels.join(", ")}]` : ""}: ${agent.modelRef}, ${agent.profileId}`;
}

/** Formats detailed configuration for one configured agent. */
export function formatAgentDetails(agent: AgentConfig): string {
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
