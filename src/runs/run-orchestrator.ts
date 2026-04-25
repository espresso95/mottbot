import type { AgentConfig, AppConfig } from "../app/config.js";
import type { CodexToolCall } from "../codex/tool-calls.js";
import {
  codexModelCapabilities,
  type ModelCapabilities,
  type ModelStreamResult,
  type ModelTokenResolver,
  type ModelTransport,
} from "../models/provider.js";
import type { Clock } from "../shared/clock.js";
import { getErrorMessage } from "../shared/errors.js";
import { createId } from "../shared/ids.js";
import type { Logger } from "../shared/logger.js";
import {
  RUN_STATUS_TEXT,
  formatRunFailedStatus,
  formatToolCompletedStatus,
  formatToolPreparingStatus,
  formatToolRunningStatus,
} from "../shared/run-status.js";
import type { SessionQueue } from "../sessions/queue.js";
import type { SessionRoute } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { MemoryStore } from "../sessions/memory-store.js";
import { buildAutomaticMemorySummary } from "../sessions/memory-summary.js";
import { buildMemoryCandidateExtractionPrompt, parseMemoryCandidateResponse } from "../sessions/memory-candidates.js";
import type { AttachmentRecordStore } from "../sessions/attachment-store.js";
import type { InboundEvent } from "../telegram/types.js";
import type { TelegramOutbox } from "../telegram/outbox.js";
import type { TelegramReactionService } from "../telegram/reactions.js";
import {
  buildRunFilesCallbackData,
  buildRunNewCallbackData,
  buildRunRetryCallbackData,
  buildRunStopCallbackData,
  buildRunUsageCallbackData,
  buildToolApprovalCallbackData,
  buildToolDenyCallbackData,
} from "../telegram/callback-data.js";
import type { TelegramInlineKeyboard } from "../telegram/command-replies.js";
import type { Message as ProviderMessage } from "@mariozechner/pi-ai";
import {
  NoopAttachmentIngestor,
  type AttachmentIngestor,
  type AttachmentPreparation,
  type TranscriptAttachmentMetadata,
} from "../telegram/attachments.js";
import type { ToolExecutor, ToolExecutionResult } from "../tools/executor.js";
import { isToolAdminRole, type ToolCallerRole, type ToolPolicyEngine } from "../tools/policy.js";
import type { ToolDefinition, ToolRegistry, ToolSideEffect } from "../tools/registry.js";
import { appendPreparedAttachmentsToLatestUserMessage } from "./attachment-inputs.js";
import { buildPrompt } from "./prompt-builder.js";
import type { RunQueueApprovedToolContinuation, RunQueueRecord, RunQueueStore } from "./run-queue-store.js";
import type { RunStore } from "./run-store.js";
import { StreamCollector } from "./stream-collector.js";
import { UsageRecorder } from "./usage-recorder.js";
import { UsageBudgetExceededError, type UsageBudgetService } from "./usage-budget.js";
import { AgentRunLimiter } from "./agent-run-limiter.js";
import type { ToolApprovalAuditRecord } from "../tools/approval.js";

const RUN_QUEUE_LEASE_MS = 10 * 60 * 1000;
const MAX_TOOL_ROUNDS_PER_RUN = 3;
const MAX_TOOL_CALLS_PER_RUN = 5;
const ATTACHMENT_RETRY_GUIDANCE =
  "This request included a file. Send the file again to retry it, or use Files below to inspect retained file metadata.";

/** Outbox operations required by run orchestration. */
export type RunOutbox = Pick<TelegramOutbox, "start" | "update" | "finish" | "fail">;

/** Telegram reaction operations required by run orchestration. */
export type RunReactionService = Pick<TelegramReactionService, "clearReaction">;

type OutboxHandle = Awaited<ReturnType<RunOutbox["start"]>>;

type ApprovedToolContinuation = RunQueueApprovedToolContinuation;

/** Outcome returned when an operator asks to retry a prior run. */
type RunRetryResult =
  | "queued"
  | "not_found"
  | "wrong_session"
  | "not_retryable"
  | "no_user_message"
  | "attachments_not_retryable";

/** Runtime policy hooks used to enforce Telegram governance before and during a run. */
type RunGovernancePolicy = {
  resolveCallerRole?: (userId: string | undefined) => ToolCallerRole;
  isModelAllowed?: (params: { chatId: string; modelRef: string }) => boolean;
  isToolAllowed?: (params: { chatId: string; toolName: string }) => boolean;
  validateAttachments?: (params: {
    chatId: string;
    attachments: readonly InboundEvent["attachments"][number][];
  }) => { message: string } | undefined;
};

/** Collaborators required to run queued Telegram messages through model orchestration. */
type RunOrchestratorOptions = {
  config: AppConfig;
  queue: SessionQueue;
  sessions: SessionStore;
  transcripts: TranscriptStore;
  runs: RunStore;
  tokenResolver: ModelTokenResolver;
  transport: ModelTransport;
  outbox: RunOutbox;
  clock: Clock;
  logger: Logger;
  attachments?: AttachmentIngestor;
  runQueue?: RunQueueStore;
  toolRegistry?: ToolRegistry;
  toolExecutor?: ToolExecutor;
  memories?: MemoryStore;
  modelCapabilities?: ModelCapabilities;
  reactions?: RunReactionService;
  attachmentRecords?: AttachmentRecordStore;
  toolPolicy?: ToolPolicyEngine;
  usageBudget?: UsageBudgetService;
  governance?: RunGovernancePolicy;
};

function buildUserTranscriptPayload(
  event: InboundEvent,
  attachments: TranscriptAttachmentMetadata[],
): {
  contentText?: string;
  contentJson?: string;
} {
  const visibleText = event.text ?? event.caption;
  const normalizedText = visibleText?.trim();
  const hasAttachments = attachments.length > 0;
  const contentText = normalizedText || (hasAttachments ? "Shared attachments." : undefined);
  const contentJson = hasAttachments
    ? JSON.stringify({
        attachments,
      })
    : undefined;
  return {
    ...(contentText ? { contentText } : {}),
    ...(contentJson ? { contentJson } : {}),
  };
}

function transcriptAttachmentsFromEvent(event: InboundEvent): TranscriptAttachmentMetadata[] {
  return event.attachments.map((attachment) => ({
    ...attachment,
    ingestionStatus: "metadata_only",
  }));
}

function toolTranscriptText(result: ToolExecutionResult): string {
  if (result.isError) {
    return result.contentText;
  }
  const details = [
    `Tool ${result.toolName} completed.`,
    `Output bytes: ${result.outputBytes}`,
    `Elapsed ms: ${result.elapsedMs}`,
    result.truncated ? "Output was truncated." : undefined,
  ].filter(Boolean);
  return details.join("\n");
}

function toolTranscriptJson(call: CodexToolCall, result: ToolExecutionResult): string {
  return JSON.stringify({
    toolCall: {
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    },
    result: {
      isError: result.isError,
      elapsedMs: result.elapsedMs,
      outputBytes: result.outputBytes,
      truncated: result.truncated,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.approvalRequestId ? { approvalRequestId: result.approvalRequestId } : {}),
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolCallFromTranscriptJson(
  contentJson: string | undefined,
  pending: ToolApprovalAuditRecord,
): CodexToolCall | undefined {
  if (!contentJson || !pending.id) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contentJson);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isRecord(parsed.result) || parsed.result.approvalRequestId !== pending.id) {
    return undefined;
  }
  const toolCall = parsed.toolCall;
  return codexToolCallFromUnknown(toolCall);
}

function codexToolCallFromUnknown(value: unknown): CodexToolCall | undefined {
  const toolCall = value;
  if (!isRecord(toolCall) || typeof toolCall.id !== "string" || typeof toolCall.name !== "string") {
    return undefined;
  }
  return {
    id: toolCall.id,
    name: toolCall.name,
    arguments: isRecord(toolCall.arguments) ? toolCall.arguments : {},
  };
}

function toolApprovalAuditRecordFromUnknown(value: unknown): ToolApprovalAuditRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.toolName !== "string" ||
    typeof value.sideEffect !== "string" ||
    typeof value.allowed !== "boolean" ||
    typeof value.decisionCode !== "string" ||
    typeof value.requestedAt !== "number" ||
    typeof value.decidedAt !== "number"
  ) {
    return undefined;
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.sessionKey === "string" ? { sessionKey: value.sessionKey } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    toolName: value.toolName,
    sideEffect: value.sideEffect as ToolApprovalAuditRecord["sideEffect"],
    allowed: value.allowed,
    decisionCode: value.decisionCode as ToolApprovalAuditRecord["decisionCode"],
    requestedAt: value.requestedAt,
    decidedAt: value.decidedAt,
    ...(typeof value.approvedByUserId === "string" ? { approvedByUserId: value.approvedByUserId } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.requestFingerprint === "string" ? { requestFingerprint: value.requestFingerprint } : {}),
    ...(typeof value.previewText === "string" ? { previewText: value.previewText } : {}),
    ...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
  };
}

function runQueueEventJson(record: RunQueueRecord): Record<string, unknown> {
  if (!record.eventJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(record.eventJson) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isAttachmentKind(value: unknown): value is InboundEvent["attachments"][number]["kind"] {
  return (
    value === "photo" ||
    value === "document" ||
    value === "audio" ||
    value === "voice" ||
    value === "video" ||
    value === "sticker" ||
    value === "animation" ||
    value === "other"
  );
}

function normalizedAttachmentFromUnknown(value: unknown): InboundEvent["attachments"][number] | undefined {
  if (!isRecord(value) || !isAttachmentKind(value.kind) || typeof value.fileId !== "string" || value.fileId === "") {
    return undefined;
  }
  return {
    kind: value.kind,
    fileId: value.fileId,
    ...(typeof value.fileUniqueId === "string" ? { fileUniqueId: value.fileUniqueId } : {}),
    ...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(typeof value.fileSize === "number" ? { fileSize: value.fileSize } : {}),
    ...(typeof value.width === "number" ? { width: value.width } : {}),
    ...(typeof value.height === "number" ? { height: value.height } : {}),
    ...(typeof value.duration === "number" ? { duration: value.duration } : {}),
  };
}

function normalizedAttachmentsFromUnknown(value: unknown): InboundEvent["attachments"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((attachment) => {
    const normalized = normalizedAttachmentFromUnknown(attachment);
    return normalized ? [normalized] : [];
  });
}

function approvedToolContinuationFromRecord(record: RunQueueRecord): ApprovedToolContinuation | undefined {
  const parsed = runQueueEventJson(record);
  const continuation = parsed.approvedToolContinuation;
  if (!isRecord(continuation) || continuation.type !== "approved_tool") {
    return undefined;
  }
  const pending = toolApprovalAuditRecordFromUnknown(continuation.pending);
  const toolCall = codexToolCallFromUnknown(continuation.toolCall);
  if (!pending || !toolCall) {
    return undefined;
  }
  return {
    type: "approved_tool",
    pending,
    toolCall,
  };
}

function buildApprovedToolAssistantMessage(params: {
  toolCall: CodexToolCall;
  session: SessionRoute;
  timestamp: number;
}): ProviderMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: params.toolCall.id,
        name: params.toolCall.name,
        arguments: params.toolCall.arguments,
      },
    ],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: params.session.modelRef.replace(/^openai-codex\//, ""),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: params.timestamp,
  };
}

function buildToolApprovalReplyMarkup(results: ToolExecutionResult[]): TelegramInlineKeyboard | undefined {
  const rows = results.flatMap((result) => {
    if (result.errorCode !== "approval_required" || !result.approvalRequestId) {
      return [];
    }
    const shortName = result.toolName.replace(/^mottbot_/, "").replace(/_/g, " ");
    return [
      [
        {
          text: `Approve ${shortName}`.slice(0, 64),
          callback_data: buildToolApprovalCallbackData(result.approvalRequestId),
        },
        {
          text: "Deny",
          callback_data: buildToolDenyCallbackData(result.approvalRequestId),
        },
      ],
    ];
  });
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

function buildActiveRunReplyMarkup(runId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [[{ text: "Stop", callback_data: buildRunStopCallbackData(runId) }]],
  };
}

function buildCompletedRunReplyMarkup(runId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "New chat", callback_data: buildRunNewCallbackData(runId) },
        { text: "Usage", callback_data: buildRunUsageCallbackData(runId) },
        { text: "Files", callback_data: buildRunFilesCallbackData(runId) },
      ],
    ],
  };
}

function buildFailedRunReplyMarkup(
  runId: string,
  options: { retry?: boolean; includeFiles?: boolean } = {},
): TelegramInlineKeyboard {
  const row = [
    ...(options.retry === false ? [] : [{ text: "Retry", callback_data: buildRunRetryCallbackData(runId) }]),
    { text: "New chat", callback_data: buildRunNewCallbackData(runId) },
    ...(options.includeFiles ? [{ text: "Files", callback_data: buildRunFilesCallbackData(runId) }] : []),
  ];
  return {
    inline_keyboard: [row],
  };
}

function buildCancelledRunReplyMarkup(runId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [[{ text: "New chat", callback_data: buildRunNewCallbackData(runId) }]],
  };
}

function hasTranscriptAttachments(contentJson: string | undefined): boolean {
  if (!contentJson) {
    return false;
  }
  try {
    const parsed = JSON.parse(contentJson) as unknown;
    return (
      Boolean(parsed) &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { attachments?: unknown }).attachments) &&
      (parsed as { attachments: unknown[] }).attachments.length > 0
    );
  } catch {
    return false;
  }
}

function appendAttachmentRetryGuidance(text: string): string {
  return `${text}\n\n${ATTACHMENT_RETRY_GUIDANCE}`;
}

const TOOL_SIDE_EFFECT_LABELS: Record<ToolSideEffect, string> = {
  read_only: "read local runtime data",
  local_write: "write local files",
  local_exec: "run configured local commands",
  network: "make network calls",
  network_write: "write through external network APIs",
  telegram_send: "send Telegram messages or reactions",
  github_write: "write through GitHub APIs",
  process_control: "control local processes",
  secret_adjacent: "read or touch sensitive local state",
};

function compactToolName(toolName: string): string {
  return toolName.replace(/^mottbot_/, "").replace(/_/g, " ");
}

function compactSingleLine(value: string | undefined, maxChars: number): string | undefined {
  const clean = value?.replace(/\s+/g, " ").trim();
  if (!clean) {
    return undefined;
  }
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function approvalPreviewField(preview: string | undefined, label: string): string | undefined {
  if (!preview) {
    return undefined;
  }
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:\\s*(.+)$`, "m").exec(preview);
  return match?.[1]?.trim();
}

function approvalPreviewArguments(preview: string | undefined): string | undefined {
  const raw = preview?.split(/\nArguments:\n/)[1]?.trim();
  return compactSingleLine(raw, 260);
}

function formatApprovalTtl(ttlMs: number): string {
  const seconds = Math.max(1, Math.round(ttlMs / 1000));
  if (seconds < 90) {
    return `${seconds} seconds`;
  }
  return `${Math.round(seconds / 60)} minutes`;
}

function appendToolApprovalCards(text: string, results: ToolExecutionResult[], approvalTtlMs: number): string {
  const pending = results.filter((result) => result.errorCode === "approval_required" && result.approvalRequestId);
  if (pending.length === 0) {
    return text;
  }
  const cards = pending.map((result, index) => {
    const preview = result.approvalPreviewText;
    const action = compactSingleLine(approvalPreviewField(preview, "Action"), 220);
    const sideEffect =
      compactSingleLine(approvalPreviewField(preview, "Side effect"), 140) ??
      (result.approvalSideEffect ? TOOL_SIDE_EFFECT_LABELS[result.approvalSideEffect] : undefined);
    const target = approvalPreviewArguments(preview);
    return [
      pending.length > 1 ? `Approval ${index + 1}` : "Approval request",
      `Tool: ${compactToolName(result.toolName)}`,
      action ? `Action: ${action}` : undefined,
      sideEffect ? `Side effect: ${sideEffect}` : undefined,
      target ? `Target: ${target}` : undefined,
      `Expires: ${formatApprovalTtl(approvalTtlMs)}`,
      result.approvalRequestId ? `Request: ${result.approvalRequestId.slice(0, 8)}` : undefined,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");
  });
  return [text.trim(), ...cards].filter(Boolean).join("\n\n");
}

/** Coordinates queued Telegram events through prompt building, model streaming, tools, memory, and outbox writes. */
export class RunOrchestrator {
  private readonly usageRecorder: UsageRecorder;
  private readonly agentLimiter = new AgentRunLimiter();
  private readonly activeRunIds = new Map<string, string>();
  private readonly config: AppConfig;
  private readonly queue: SessionQueue;
  private readonly sessions: SessionStore;
  private readonly transcripts: TranscriptStore;
  private readonly runs: RunStore;
  private readonly tokenResolver: ModelTokenResolver;
  private readonly transport: ModelTransport;
  private readonly outbox: RunOutbox;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly attachments: AttachmentIngestor;
  private readonly runQueue?: RunQueueStore;
  private readonly toolRegistry?: ToolRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly memories?: MemoryStore;
  private readonly modelCapabilities: ModelCapabilities;
  private readonly reactions?: RunReactionService;
  private readonly attachmentRecords?: AttachmentRecordStore;
  private readonly toolPolicy?: ToolPolicyEngine;
  private readonly usageBudget?: UsageBudgetService;
  private readonly governance?: RunGovernancePolicy;

  constructor(options: RunOrchestratorOptions) {
    this.config = options.config;
    this.queue = options.queue;
    this.sessions = options.sessions;
    this.transcripts = options.transcripts;
    this.runs = options.runs;
    this.tokenResolver = options.tokenResolver;
    this.transport = options.transport;
    this.outbox = options.outbox;
    this.clock = options.clock;
    this.logger = options.logger;
    this.attachments = options.attachments ?? new NoopAttachmentIngestor();
    this.runQueue = options.runQueue;
    this.toolRegistry = options.toolRegistry;
    this.toolExecutor = options.toolExecutor;
    this.memories = options.memories;
    this.modelCapabilities = options.modelCapabilities ?? codexModelCapabilities;
    this.reactions = options.reactions;
    this.attachmentRecords = options.attachmentRecords;
    this.toolPolicy = options.toolPolicy;
    this.usageBudget = options.usageBudget;
    this.governance = options.governance;
    this.usageRecorder = new UsageRecorder(this.runs);
  }

  async enqueueMessage(params: { event: InboundEvent; session: SessionRoute }): Promise<void> {
    this.sessions.ensure({
      sessionKey: params.session.sessionKey,
      chatId: params.session.chatId,
      threadId: params.session.threadId,
      userId: params.session.userId,
      routeMode: params.session.routeMode,
      profileId: params.session.profileId,
      modelRef: params.session.modelRef,
      boundName: params.session.boundName,
      agentId: params.session.agentId,
      fastMode: params.session.fastMode,
      systemPrompt: params.session.systemPrompt,
    });

    const userPayload = buildUserTranscriptPayload(params.event, transcriptAttachmentsFromEvent(params.event));
    if (!userPayload.contentText) {
      return;
    }
    const agent = this.agentForSession(params.session);
    const queueLimitMessage = this.agentQueueLimitMessage(params.session, agent);
    if (queueLimitMessage) {
      await this.rejectRunAtEnqueue({
        event: params.event,
        session: params.session,
        userPayload,
        errorCode: "agent_queue_full",
        errorMessage: queueLimitMessage,
      });
      return;
    }

    const run = this.runs.create({
      sessionKey: params.session.sessionKey,
      agentId: params.session.agentId,
      modelRef: params.session.modelRef,
      profileId: params.session.profileId,
    });
    this.logger.info(
      {
        runId: run.runId,
        sessionKey: params.session.sessionKey,
        chatId: params.event.chatId,
        modelRef: params.session.modelRef,
        profileId: params.session.profileId,
        attachmentCount: params.event.attachments.length,
      },
      "Queued run.",
    );

    this.transcripts.add({
      sessionKey: params.session.sessionKey,
      runId: run.runId,
      role: "user",
      contentText: userPayload.contentText,
      contentJson: userPayload.contentJson,
      telegramMessageId: params.event.messageId,
      replyToTelegramMessageId: params.event.replyToMessageId,
    });

    this.runQueue?.create({
      runId: run.runId,
      sessionKey: params.session.sessionKey,
      event: params.event,
    });
    this.enqueueRun({
      event: params.event,
      session: params.session,
      runId: run.runId,
    });
  }

  async continueApprovedTool(params: {
    event: InboundEvent;
    session: SessionRoute;
    pending: ToolApprovalAuditRecord;
  }): Promise<boolean> {
    if (!this.toolRegistry || !this.toolExecutor) {
      return false;
    }
    const continuation = this.findApprovedToolContinuation(params.session.sessionKey, params.pending);
    if (!continuation) {
      return false;
    }
    this.sessions.ensure({
      sessionKey: params.session.sessionKey,
      chatId: params.session.chatId,
      threadId: params.session.threadId,
      userId: params.session.userId,
      routeMode: params.session.routeMode,
      profileId: params.session.profileId,
      modelRef: params.session.modelRef,
      boundName: params.session.boundName,
      agentId: params.session.agentId,
      fastMode: params.session.fastMode,
      systemPrompt: params.session.systemPrompt,
    });

    const agent = this.agentForSession(params.session);
    const queueLimitMessage = this.agentQueueLimitMessage(params.session, agent);
    if (queueLimitMessage) {
      await this.rejectContinuationAtEnqueue({
        event: params.event,
        session: params.session,
        errorCode: "agent_queue_full",
        errorMessage: queueLimitMessage,
      });
      return true;
    }

    const run = this.runs.create({
      sessionKey: params.session.sessionKey,
      agentId: params.session.agentId,
      modelRef: params.session.modelRef,
      profileId: params.session.profileId,
    });
    this.runQueue?.create({
      runId: run.runId,
      sessionKey: params.session.sessionKey,
      event: params.event,
      approvedToolContinuation: continuation,
    });
    this.logger.info(
      {
        runId: run.runId,
        sessionKey: params.session.sessionKey,
        chatId: params.event.chatId,
        modelRef: params.session.modelRef,
        profileId: params.session.profileId,
        toolName: continuation.toolCall.name,
      },
      "Queued approved tool continuation.",
    );
    this.enqueueRun({
      event: params.event,
      session: params.session,
      runId: run.runId,
      approvedToolContinuation: continuation,
    });
    return true;
  }

  async stop(sessionKey: string, runId?: string): Promise<boolean> {
    if (runId && this.activeRunIds.get(sessionKey) !== runId) {
      return false;
    }
    return this.queue.cancel(sessionKey);
  }

  async retryRun(params: { event: InboundEvent; session: SessionRoute; runId: string }): Promise<RunRetryResult> {
    const run = this.runs.get(params.runId);
    if (!run) {
      return "not_found";
    }
    if (run.sessionKey !== params.session.sessionKey) {
      return "wrong_session";
    }
    if (run.status !== "failed" && run.status !== "cancelled") {
      return "not_retryable";
    }
    const message = this.transcripts.getRunMessage(run.runId, "user");
    if (!message) {
      return "no_user_message";
    }
    const text = message.contentText?.trim();
    if (!text) {
      return "no_user_message";
    }
    if (hasTranscriptAttachments(message.contentJson)) {
      return "attachments_not_retryable";
    }
    await this.enqueueMessage({
      event: {
        ...params.event,
        text,
        entities: [],
        attachments: [],
        mentionsBot: false,
        isCommand: false,
        replyToMessageId: params.event.messageId,
      },
      session: params.session,
    });
    return "queued";
  }

  recoverQueuedRuns(): { resumed: number; failed: number } {
    if (!this.runQueue) {
      return { resumed: 0, failed: 0 };
    }
    let resumed = 0;
    let failed = 0;
    for (const record of this.runQueue.listRecoverableQueued()) {
      const run = this.runs.get(record.runId);
      const session = this.sessions.get(record.sessionKey);
      const approvedToolContinuation = approvedToolContinuationFromRecord(record);
      const canRecoverRunMessage = this.transcripts.hasRunMessage(record.runId, "user");
      if (!run || !session || (!approvedToolContinuation && !canRecoverRunMessage)) {
        failed += 1;
        this.markQueuedRunUnrecoverable(record, "Queued run could not be recovered after restart.");
        continue;
      }
      this.enqueueRun({
        event: this.rebuildEvent(record, session),
        session,
        runId: record.runId,
        recovered: true,
        ...(approvedToolContinuation ? { approvedToolContinuation } : {}),
      });
      resumed += 1;
    }
    return { resumed, failed };
  }

  private enqueueRun(params: {
    event: InboundEvent;
    session: SessionRoute;
    runId: string;
    recovered?: boolean;
    approvedToolContinuation?: ApprovedToolContinuation;
  }): void {
    void this.queue
      .enqueue(params.session.sessionKey, async (signal) => {
        const agent = this.agentForSession(params.session);
        await this.agentLimiter.run(params.session.agentId, agent?.maxConcurrentRuns, async () => {
          if (
            this.runQueue &&
            !this.runQueue.claim(params.runId, RUN_QUEUE_LEASE_MS, { recoverClaimed: params.recovered === true })
          ) {
            return;
          }
          this.activeRunIds.set(params.session.sessionKey, params.runId);
          try {
            await this.execute({
              event: params.event,
              session: params.session,
              runId: params.runId,
              placeholderText: params.recovered ? RUN_STATUS_TEXT.resumingAfterRestart : RUN_STATUS_TEXT.starting,
              signal,
              approvedToolContinuation: params.approvedToolContinuation,
            });
          } finally {
            if (this.activeRunIds.get(params.session.sessionKey) === params.runId) {
              this.activeRunIds.delete(params.session.sessionKey);
            }
          }
          const finalRun = this.runs.get(params.runId);
          if (!this.runQueue || !finalRun) {
            return;
          }
          if (finalRun.status === "completed") {
            this.runQueue.complete(params.runId);
            return;
          }
          this.runQueue.fail(params.runId, finalRun.errorMessage ?? finalRun.status);
        });
      })
      .catch((error) => {
        this.runQueue?.fail(params.runId, getErrorMessage(error));
        this.logger.error({ error, runId: params.runId }, "Queued run failed.");
      });
  }

  private agentQueueLimitMessage(session: SessionRoute, agent: AgentConfig | undefined): string | undefined {
    if (agent?.maxQueuedRuns === undefined) {
      return undefined;
    }
    const queued = this.runs.countByAgentStatuses(session.agentId, ["queued"]);
    if (queued < agent.maxQueuedRuns) {
      return undefined;
    }
    return `Agent ${session.agentId} queue is full (${queued}/${agent.maxQueuedRuns} queued runs). Try again after current work finishes.`;
  }

  private async rejectRunAtEnqueue(params: {
    event: InboundEvent;
    session: SessionRoute;
    userPayload: { contentText?: string; contentJson?: string };
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    const run = this.runs.create({
      sessionKey: params.session.sessionKey,
      agentId: params.session.agentId,
      modelRef: params.session.modelRef,
      profileId: params.session.profileId,
    });
    this.transcripts.add({
      sessionKey: params.session.sessionKey,
      runId: run.runId,
      role: "user",
      contentText: params.userPayload.contentText,
      contentJson: params.userPayload.contentJson,
      telegramMessageId: params.event.messageId,
      replyToTelegramMessageId: params.event.replyToMessageId,
    });
    this.runs.update(run.runId, {
      status: "failed",
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      finishedAt: this.clock.now(),
    });
    try {
      const placeholder = await this.outbox.start({
        runId: run.runId,
        chatId: params.event.chatId,
        threadId: params.event.threadId,
        replyToMessageId: params.event.messageId,
        placeholderText: RUN_STATUS_TEXT.starting,
      });
      const attachmentBacked = hasTranscriptAttachments(params.userPayload.contentJson);
      const failedStatus = formatRunFailedStatus(params.errorMessage);
      await this.outbox.fail(
        placeholder,
        attachmentBacked ? appendAttachmentRetryGuidance(failedStatus) : failedStatus,
        {
          replyMarkup: buildFailedRunReplyMarkup(run.runId, {
            retry: !attachmentBacked,
            includeFiles: attachmentBacked,
          }),
        },
      );
    } catch (error) {
      this.logger.warn({ error, runId: run.runId }, "Failed to send enqueue rejection.");
    }
  }

  private async rejectContinuationAtEnqueue(params: {
    event: InboundEvent;
    session: SessionRoute;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    const run = this.runs.create({
      sessionKey: params.session.sessionKey,
      agentId: params.session.agentId,
      modelRef: params.session.modelRef,
      profileId: params.session.profileId,
    });
    this.runs.update(run.runId, {
      status: "failed",
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      finishedAt: this.clock.now(),
    });
    try {
      const placeholder = await this.outbox.start({
        runId: run.runId,
        chatId: params.event.chatId,
        threadId: params.event.threadId,
        replyToMessageId: params.event.messageId,
        placeholderText: RUN_STATUS_TEXT.starting,
      });
      await this.outbox.fail(placeholder, formatRunFailedStatus(params.errorMessage), {
        replyMarkup: buildFailedRunReplyMarkup(run.runId),
      });
    } catch (error) {
      this.logger.warn({ error, runId: run.runId }, "Failed to send approved-tool continuation rejection.");
    }
  }

  private async execute(params: {
    event: InboundEvent;
    session: SessionRoute;
    runId: string;
    placeholderText: string;
    signal: AbortSignal;
    approvedToolContinuation?: ApprovedToolContinuation;
  }): Promise<void> {
    const run = this.runs.get(params.runId);
    if (!run) {
      throw new Error(`Unknown queued run ${params.runId}.`);
    }
    let placeholder: Awaited<ReturnType<TelegramOutbox["start"]>> | undefined;
    let attachmentPreparation: AttachmentPreparation | undefined;
    let attachmentCleaned = false;
    const currentPlaceholder = () => {
      if (!placeholder) {
        throw new Error("Run outbox placeholder was not initialized.");
      }
      return placeholder;
    };
    const cleanupAttachments = async () => {
      if (!attachmentPreparation || attachmentCleaned) {
        return;
      }
      attachmentCleaned = true;
      try {
        await this.attachments.cleanup(attachmentPreparation);
      } catch (error) {
        this.logger.warn({ error }, "Failed to clean up attachment cache files.");
      }
    };

    try {
      const activeReplyMarkup = buildActiveRunReplyMarkup(run.runId);
      this.runs.update(run.runId, {
        status: "starting",
        startedAt: this.clock.now(),
      });
      placeholder = await this.outbox.start({
        runId: run.runId,
        chatId: params.event.chatId,
        threadId: params.event.threadId,
        replyToMessageId: params.event.messageId,
        placeholderText: params.placeholderText,
        replyMarkup: activeReplyMarkup,
      });
      this.logger.info(
        {
          runId: run.runId,
          sessionKey: params.session.sessionKey,
          chatId: params.event.chatId,
          modelRef: params.session.modelRef,
          profileId: params.session.profileId,
        },
        "Run starting.",
      );
      const attachmentPolicyViolation = this.governance?.validateAttachments?.({
        chatId: params.event.chatId,
        attachments: params.event.attachments,
      });
      if (attachmentPolicyViolation) {
        throw new Error(attachmentPolicyViolation.message);
      }
      if (
        this.governance?.isModelAllowed &&
        !this.governance.isModelAllowed({ chatId: params.event.chatId, modelRef: params.session.modelRef })
      ) {
        throw new Error(`Model ${params.session.modelRef} is not allowed in this chat.`);
      }
      const budgetDecision = this.usageBudget?.evaluate({
        session: params.session,
        modelRef: params.session.modelRef,
        currentRunId: run.runId,
      });
      if (budgetDecision && !budgetDecision.allowed) {
        throw new UsageBudgetExceededError(budgetDecision.deniedReason ?? "Usage budget exceeded.");
      }
      if (budgetDecision?.warnings.length) {
        placeholder = await this.outbox.update(
          currentPlaceholder(),
          [RUN_STATUS_TEXT.starting, ...budgetDecision.warnings].join("\n"),
          { replyMarkup: activeReplyMarkup },
        );
      }
      const auth = await this.tokenResolver.resolve(params.session.profileId);
      attachmentPreparation = await this.attachments.prepare({
        attachments: params.event.attachments,
        allowNativeImages: this.modelCapabilities.supportsNativeImageInput(params.session.modelRef),
        allowNativeFiles: this.modelCapabilities.supportsNativeFileInput(params.session.modelRef),
        signal: params.signal,
      });
      if (params.event.attachments.length > 0) {
        attachmentPreparation = this.assignAttachmentRecordIds(attachmentPreparation);
        this.attachmentRecords?.addMany({
          sessionKey: params.session.sessionKey,
          runId: run.runId,
          telegramMessageId: params.event.messageId,
          attachments: attachmentPreparation.transcriptAttachments,
        });
        this.transcripts.updateRunMessageContentJson(
          run.runId,
          "user",
          JSON.stringify({ attachments: attachmentPreparation.transcriptAttachments }),
        );
      }
      const history = this.transcripts.listRecent(params.session.sessionKey, 30);
      const prompt = buildPrompt({
        history,
        systemPrompt: params.session.systemPrompt,
        memories: this.memories?.listForScopeContext(params.session),
      });
      const messages = appendPreparedAttachmentsToLatestUserMessage({
        messages: prompt.messages,
        nativeInputs: attachmentPreparation.nativeInputs,
        extractedTexts: attachmentPreparation.extractedTexts,
      });
      await cleanupAttachments();
      const collector = new StreamCollector();
      const callerRole = this.callerRole(params.event.fromUserId);
      const includeAdminTools = isToolAdminRole(callerRole);
      const toolDeclarations =
        this.toolRegistry && this.toolExecutor
          ? this.toolRegistry.listModelDeclarations({
              includeAdminTools,
              filter: (definition) =>
                this.isToolAllowedByAgent(params.session, definition) &&
                (this.toolPolicy?.evaluate(
                  definition,
                  {
                    role: callerRole,
                    chatId: params.event.chatId,
                  },
                  {
                    override: this.agentForSession(params.session)?.toolPolicies?.[definition.name],
                  },
                ).allowed ??
                  true) &&
                (this.governance?.isToolAllowed?.({
                  chatId: params.event.chatId,
                  toolName: definition.name,
                }) ??
                  true),
            })
          : undefined;
      const extraContextMessages: ProviderMessage[] = [];
      const executedToolResults: ToolExecutionResult[] = [];
      let result: ModelStreamResult | undefined;
      let toolRounds = 0;
      let totalToolCalls = 0;

      if (params.approvedToolContinuation) {
        if (!this.toolExecutor || !this.toolRegistry || !toolDeclarations || toolDeclarations.length === 0) {
          throw new Error("Approved tool continuation requested, but tool execution is disabled.");
        }
        extraContextMessages.push(
          buildApprovedToolAssistantMessage({
            toolCall: params.approvedToolContinuation.toolCall,
            session: params.session,
            timestamp: this.clock.now(),
          }),
        );
        totalToolCalls += 1;
        placeholder = await this.executeToolCallForRun({
          toolCall: params.approvedToolContinuation.toolCall,
          event: params.event,
          session: params.session,
          runId: run.runId,
          signal: params.signal,
          placeholder: currentPlaceholder(),
          activeReplyMarkup,
          extraContextMessages,
          executedToolResults,
        });
      }

      while (true) {
        result = await this.transport.stream({
          sessionKey: params.session.sessionKey,
          modelRef: params.session.modelRef,
          transport: this.config.models.transport,
          auth,
          systemPrompt: prompt.systemPrompt,
          messages,
          ...(toolDeclarations && toolDeclarations.length > 0 ? { tools: toolDeclarations } : {}),
          ...(extraContextMessages.length > 0 ? { extraContextMessages } : {}),
          signal: params.signal,
          fastMode: params.session.fastMode,
          onStart: async () => {
            this.runs.update(run.runId, { status: "streaming" });
          },
          onTextDelta: async (delta) => {
            const nextText = collector.appendText(delta);
            placeholder = await this.outbox.update(currentPlaceholder(), nextText, { replyMarkup: activeReplyMarkup });
          },
          onThinkingDelta: async (delta) => {
            collector.appendThinking(delta);
          },
          onToolCallStart: async (toolCall) => {
            if (toolCall.name) {
              placeholder = await this.outbox.update(currentPlaceholder(), formatToolPreparingStatus(toolCall.name), {
                replyMarkup: activeReplyMarkup,
              });
            }
          },
        });

        const toolCalls = result.toolCalls ?? [];
        if (toolCalls.length === 0) {
          break;
        }
        if (!this.toolExecutor || !this.toolRegistry || !toolDeclarations || toolDeclarations.length === 0) {
          throw new Error("Model requested tools, but tool execution is disabled.");
        }
        if (toolRounds >= MAX_TOOL_ROUNDS_PER_RUN) {
          throw new Error(`Model exceeded the ${MAX_TOOL_ROUNDS_PER_RUN} tool-round limit.`);
        }
        if (totalToolCalls + toolCalls.length > MAX_TOOL_CALLS_PER_RUN) {
          throw new Error(`Model exceeded the ${MAX_TOOL_CALLS_PER_RUN} tool-call limit.`);
        }
        if (!result.assistantMessage) {
          throw new Error("Model requested a tool without returning an assistant tool-call message.");
        }

        extraContextMessages.push(result.assistantMessage);
        totalToolCalls += toolCalls.length;
        toolRounds += 1;

        for (const toolCall of toolCalls) {
          placeholder = await this.executeToolCallForRun({
            toolCall,
            event: params.event,
            session: params.session,
            runId: run.runId,
            signal: params.signal,
            placeholder: currentPlaceholder(),
            activeReplyMarkup,
            extraContextMessages,
            executedToolResults,
          });
        }
      }
      if (!result) {
        throw new Error("No model response was produced.");
      }
      const finalText = result.text.trim() || collector.getText().trim();
      const approvalReplyMarkup = buildToolApprovalReplyMarkup(executedToolResults);
      const visibleText = appendToolApprovalCards(
        finalText || "No response generated.",
        executedToolResults,
        this.config.tools.approvalTtlMs,
      );
      const delivery = await this.outbox.finish(currentPlaceholder(), visibleText, {
        replyMarkup: approvalReplyMarkup ?? buildCompletedRunReplyMarkup(run.runId),
      });
      const thinking = result.thinking || collector.getThinking();
      const assistantEnvelope = {
        ...(thinking ? { thinking } : {}),
        ...(delivery.continuationMessageIds.length > 0
          ? { continuationMessageIds: delivery.continuationMessageIds }
          : {}),
        ...(executedToolResults.length > 0
          ? {
              tools: executedToolResults.map((toolResult) => ({
                toolCallId: toolResult.toolCallId,
                toolName: toolResult.toolName,
                isError: toolResult.isError,
                elapsedMs: toolResult.elapsedMs,
                outputBytes: toolResult.outputBytes,
                truncated: toolResult.truncated,
                ...(toolResult.errorCode ? { errorCode: toolResult.errorCode } : {}),
                ...(toolResult.approvalRequestId ? { approvalRequestId: toolResult.approvalRequestId } : {}),
              })),
            }
          : {}),
      };
      this.transcripts.add({
        sessionKey: params.session.sessionKey,
        runId: run.runId,
        role: "assistant",
        contentText: visibleText,
        telegramMessageId: delivery.primaryMessageId,
        contentJson: Object.keys(assistantEnvelope).length > 0 ? JSON.stringify(assistantEnvelope) : undefined,
      });
      this.updateAutomaticMemorySummary(params.session.sessionKey);
      await this.proposeMemoryCandidates({
        session: params.session,
        auth,
        signal: params.signal,
      });
      this.usageRecorder.record(run.runId, result.usage);
      this.runs.update(run.runId, {
        status: "completed",
        transport: result.transport,
        requestIdentity: result.requestIdentity,
        finishedAt: this.clock.now(),
      });
      await this.removeAckReactionAfterReply(params.event);
      this.logger.info(
        {
          runId: run.runId,
          sessionKey: params.session.sessionKey,
          chatId: params.event.chatId,
          transport: result.transport,
        },
        "Run completed.",
      );
    } catch (error) {
      await cleanupAttachments();
      const message = getErrorMessage(error);
      const errorCode = params.signal.aborted
        ? "cancelled"
        : error instanceof UsageBudgetExceededError
          ? error.code
          : "run_failed";
      this.logger.error(
        {
          error,
          runId: run.runId,
          sessionKey: params.session.sessionKey,
          chatId: params.event.chatId,
          errorCode,
        },
        "Run execution failed.",
      );
      this.runs.update(run.runId, {
        status: params.signal.aborted ? "cancelled" : "failed",
        errorCode,
        errorMessage: message,
        finishedAt: this.clock.now(),
      });
      if (placeholder) {
        try {
          const failedStatus = formatRunFailedStatus(message);
          const attachmentBacked =
            !params.signal.aborted &&
            hasTranscriptAttachments(this.transcripts.getRunMessage(run.runId, "user")?.contentJson);
          await this.outbox.fail(
            placeholder,
            attachmentBacked ? appendAttachmentRetryGuidance(failedStatus) : failedStatus,
            {
              replyMarkup: params.signal.aborted
                ? buildCancelledRunReplyMarkup(run.runId)
                : buildFailedRunReplyMarkup(run.runId, {
                    retry: !attachmentBacked,
                    includeFiles: attachmentBacked,
                  }),
            },
          );
        } catch (outboxError) {
          this.logger.warn({ error: outboxError, runId: run.runId }, "Failed to send run failure status.");
        }
      }
      await this.removeAckReactionAfterReply(params.event);
    }
  }

  private updateAutomaticMemorySummary(sessionKey: string): void {
    if (!this.config.memory.autoSummariesEnabled || !this.memories) {
      return;
    }
    const summary = buildAutomaticMemorySummary({
      messages: this.transcripts.listRecent(sessionKey, this.config.memory.autoSummaryRecentMessages),
      maxChars: this.config.memory.autoSummaryMaxChars,
    });
    if (!summary) {
      return;
    }
    this.memories.upsertAutoSummary({
      sessionKey,
      contentText: summary,
    });
  }

  private callerRole(userId: string | undefined): ToolCallerRole {
    return (
      this.governance?.resolveCallerRole?.(userId) ??
      (userId && this.config.telegram.adminUserIds.includes(userId) ? "owner" : "user")
    );
  }

  private agentForSession(session: SessionRoute) {
    return this.config.agents.list.find((agent) => agent.id === session.agentId);
  }

  private isToolAllowedByAgent(session: SessionRoute, definition: ToolDefinition): boolean {
    const agent = this.agentForSession(session);
    return !agent?.toolNames || agent.toolNames.length === 0 || agent.toolNames.includes(definition.name);
  }

  private findApprovedToolContinuation(
    sessionKey: string,
    pending: ToolApprovalAuditRecord,
  ): ApprovedToolContinuation | undefined {
    if (!pending.id) {
      return undefined;
    }
    const messages = this.transcripts.listRecent(sessionKey, 100);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "tool") {
        continue;
      }
      if (pending.runId && message.runId !== pending.runId) {
        continue;
      }
      const toolCall = toolCallFromTranscriptJson(message.contentJson, pending);
      if (toolCall?.name === pending.toolName) {
        return { type: "approved_tool", pending, toolCall };
      }
    }
    return undefined;
  }

  private async executeToolCallForRun(params: {
    toolCall: CodexToolCall;
    event: InboundEvent;
    session: SessionRoute;
    runId: string;
    signal: AbortSignal;
    placeholder: OutboxHandle;
    activeReplyMarkup: TelegramInlineKeyboard;
    extraContextMessages: ProviderMessage[];
    executedToolResults: ToolExecutionResult[];
  }): Promise<OutboxHandle> {
    if (!this.toolExecutor) {
      throw new Error("Model requested tools, but tool execution is disabled.");
    }
    let placeholder = await this.outbox.update(params.placeholder, formatToolRunningStatus(params.toolCall.name), {
      replyMarkup: params.activeReplyMarkup,
    });
    const execution = await this.toolExecutor.execute(params.toolCall, {
      signal: params.signal,
      sessionKey: params.session.sessionKey,
      runId: params.runId,
      requestedByUserId: params.event.fromUserId,
      chatId: params.event.chatId,
      threadId: params.event.threadId,
      allowedToolNames: this.agentForSession(params.session)?.toolNames,
      toolPolicyOverrides: this.agentForSession(params.session)?.toolPolicies,
    });
    params.executedToolResults.push(execution);
    this.transcripts.add({
      sessionKey: params.session.sessionKey,
      runId: params.runId,
      role: "tool",
      contentText: toolTranscriptText(execution),
      contentJson: toolTranscriptJson(params.toolCall, execution),
    });
    params.extraContextMessages.push(this.toolExecutor.toToolResultMessage(execution));
    placeholder = await this.outbox.update(
      placeholder,
      formatToolCompletedStatus({ toolName: execution.toolName, isError: execution.isError }),
      { replyMarkup: params.activeReplyMarkup },
    );
    this.logger.info(
      {
        runId: params.runId,
        sessionKey: params.session.sessionKey,
        toolName: execution.toolName,
        isError: execution.isError,
        elapsedMs: execution.elapsedMs,
        outputBytes: execution.outputBytes,
        truncated: execution.truncated,
        errorCode: execution.errorCode,
      },
      "Tool call completed.",
    );
    return placeholder;
  }

  private async proposeMemoryCandidates(params: {
    session: SessionRoute;
    auth: Awaited<ReturnType<ModelTokenResolver["resolve"]>>;
    signal: AbortSignal;
  }): Promise<void> {
    if (!this.config.memory.candidateExtractionEnabled || !this.memories) {
      return;
    }
    const extractionPrompt = buildMemoryCandidateExtractionPrompt({
      messages: this.transcripts.listRecent(params.session.sessionKey, this.config.memory.candidateRecentMessages),
      maxCandidates: this.config.memory.candidateMaxPerRun,
    });
    if (!extractionPrompt) {
      return;
    }
    try {
      const result = await this.transport.stream({
        sessionKey: params.session.sessionKey,
        modelRef: params.session.modelRef,
        transport: this.config.models.transport,
        auth: params.auth,
        systemPrompt: extractionPrompt.systemPrompt,
        messages: extractionPrompt.messages,
        signal: params.signal,
        fastMode: true,
      });
      const candidates = parseMemoryCandidateResponse({
        raw: result.text,
        context: params.session,
        allowedSourceMessageIds: extractionPrompt.sourceMessageIds,
      }).slice(0, this.config.memory.candidateMaxPerRun);
      let inserted = 0;
      for (const candidate of candidates) {
        const outcome = this.memories.addCandidate({
          sessionKey: params.session.sessionKey,
          scope: candidate.scope,
          scopeKey: candidate.scopeKey,
          contentText: candidate.contentText,
          reason: candidate.reason,
          sourceMessageIds: candidate.sourceMessageIds,
          sensitivity: candidate.sensitivity,
          proposedBy: "model",
        });
        if (outcome.inserted) {
          inserted += 1;
        }
      }
      if (inserted > 0) {
        this.logger.info(
          {
            sessionKey: params.session.sessionKey,
            inserted,
          },
          "Stored memory candidates for review.",
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          error,
          sessionKey: params.session.sessionKey,
        },
        "Failed to extract memory candidates.",
      );
    }
  }

  private async removeAckReactionAfterReply(event: InboundEvent): Promise<void> {
    const ackEmoji = this.config.telegram.reactions.ackEmoji.trim();
    if (
      !this.reactions ||
      !this.config.telegram.reactions.enabled ||
      !this.config.telegram.reactions.removeAckAfterReply ||
      !ackEmoji
    ) {
      return;
    }
    try {
      await this.reactions.clearReaction({
        chatId: event.chatId,
        messageId: event.messageId,
      });
    } catch (error) {
      this.logger.warn({ error }, "Failed to remove Telegram ack reaction.");
    }
  }

  private rebuildEvent(record: RunQueueRecord, session: SessionRoute): InboundEvent {
    const parsed = runQueueEventJson(record);
    const chatType =
      parsed.chatType === "private" ||
      parsed.chatType === "group" ||
      parsed.chatType === "supergroup" ||
      parsed.chatType === "channel"
        ? parsed.chatType
        : session.routeMode === "dm"
          ? "private"
          : "group";
    return {
      updateId: 0,
      chatId: record.chatId,
      chatType,
      messageId: record.messageId,
      ...(typeof record.threadId === "number" ? { threadId: record.threadId } : {}),
      ...(typeof parsed.fromUserId === "string" ? { fromUserId: parsed.fromUserId } : {}),
      ...(typeof parsed.fromUsername === "string" ? { fromUsername: parsed.fromUsername } : {}),
      ...(typeof parsed.text === "string" ? { text: parsed.text } : {}),
      ...(typeof parsed.caption === "string" ? { caption: parsed.caption } : {}),
      entities: [],
      attachments: normalizedAttachmentsFromUnknown(parsed.attachments),
      ...(typeof record.replyToMessageId === "number" ? { replyToMessageId: record.replyToMessageId } : {}),
      mentionsBot: parsed.mentionsBot === true,
      isCommand: parsed.isCommand === true,
      arrivedAt: typeof parsed.arrivedAt === "number" ? parsed.arrivedAt : this.clock.now(),
    };
  }

  private assignAttachmentRecordIds(preparation: AttachmentPreparation): AttachmentPreparation {
    return {
      ...preparation,
      transcriptAttachments: preparation.transcriptAttachments.map((attachment) => ({
        ...attachment,
        recordId: attachment.recordId ?? createId(),
      })),
    };
  }

  private markQueuedRunUnrecoverable(record: RunQueueRecord, message: string): void {
    const run = this.runs.get(record.runId);
    if (run) {
      this.runs.update(record.runId, {
        status: "failed",
        errorCode: "queued_recovery_failed",
        errorMessage: message,
        finishedAt: this.clock.now(),
      });
    }
    this.runQueue?.fail(record.runId, message);
    void this.outbox
      .start({
        runId: record.runId,
        chatId: record.chatId,
        threadId: record.threadId,
        replyToMessageId: record.messageId,
        placeholderText: RUN_STATUS_TEXT.unableToResumeAfterRestart,
      })
      .then(async (handle) => {
        await this.outbox.fail(handle, formatRunFailedStatus(message), {
          replyMarkup: buildFailedRunReplyMarkup(record.runId),
        });
      })
      .catch((error) => {
        this.logger.warn({ error, runId: record.runId }, "Failed to notify chat about unrecoverable queued run.");
      });
  }
}
