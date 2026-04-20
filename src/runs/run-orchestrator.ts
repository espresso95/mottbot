import type { AppConfig } from "../app/config.js";
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
import {
  buildMemoryCandidateExtractionPrompt,
  parseMemoryCandidateResponse,
} from "../sessions/memory-candidates.js";
import type { AttachmentRecordStore } from "../sessions/attachment-store.js";
import type { InboundEvent } from "../telegram/types.js";
import type { TelegramOutbox } from "../telegram/outbox.js";
import type { TelegramReactionService } from "../telegram/reactions.js";
import type { Message as ProviderMessage } from "@mariozechner/pi-ai";
import {
  NoopAttachmentIngestor,
  type AttachmentIngestor,
  type AttachmentPreparation,
  type TranscriptAttachmentMetadata,
} from "../telegram/attachments.js";
import type { ToolExecutor, ToolExecutionResult } from "../tools/executor.js";
import type { ToolCallerRole, ToolPolicyEngine } from "../tools/policy.js";
import type { ToolRegistry } from "../tools/registry.js";
import { appendPreparedAttachmentsToLatestUserMessage } from "./attachment-inputs.js";
import { buildPrompt } from "./prompt-builder.js";
import type { RunQueueRecord, RunQueueStore } from "./run-queue-store.js";
import type { RunStore } from "./run-store.js";
import { StreamCollector } from "./stream-collector.js";
import { UsageRecorder } from "./usage-recorder.js";

const RUN_QUEUE_LEASE_MS = 10 * 60 * 1000;
const MAX_TOOL_ROUNDS_PER_RUN = 3;
const MAX_TOOL_CALLS_PER_RUN = 5;

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
    },
  });
}

export class RunOrchestrator {
  private readonly usageRecorder: UsageRecorder;

  constructor(
    private readonly config: AppConfig,
    private readonly queue: SessionQueue,
    private readonly sessions: SessionStore,
    private readonly transcripts: TranscriptStore,
    private readonly runs: RunStore,
    private readonly tokenResolver: ModelTokenResolver,
    private readonly transport: ModelTransport,
    private readonly outbox: TelegramOutbox,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly attachments: AttachmentIngestor = new NoopAttachmentIngestor(),
    private readonly runQueue?: RunQueueStore,
    private readonly toolRegistry?: ToolRegistry,
    private readonly toolExecutor?: ToolExecutor,
    private readonly memories?: MemoryStore,
    private readonly modelCapabilities: ModelCapabilities = codexModelCapabilities,
    private readonly reactions?: TelegramReactionService,
    private readonly attachmentRecords?: AttachmentRecordStore,
    private readonly toolPolicy?: ToolPolicyEngine,
  ) {
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
    });

    const userPayload = buildUserTranscriptPayload(params.event, transcriptAttachmentsFromEvent(params.event));
    if (!userPayload.contentText) {
      return;
    }

    const run = this.runs.create({
      sessionKey: params.session.sessionKey,
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

  async stop(sessionKey: string): Promise<boolean> {
    return this.queue.cancel(sessionKey);
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
      if (!run || !session || !this.transcripts.hasRunMessage(record.runId, "user")) {
        failed += 1;
        this.markQueuedRunUnrecoverable(record, "Queued run could not be recovered after restart.");
        continue;
      }
      this.enqueueRun({
        event: this.rebuildEvent(record, session),
        session,
        runId: record.runId,
        recovered: true,
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
  }): void {
    void this.queue.enqueue(params.session.sessionKey, async (signal) => {
      if (
        this.runQueue &&
        !this.runQueue.claim(params.runId, RUN_QUEUE_LEASE_MS, { recoverClaimed: params.recovered === true })
      ) {
        return;
      }
      await this.execute({
        event: params.event,
        session: params.session,
        runId: params.runId,
        placeholderText: params.recovered ? RUN_STATUS_TEXT.resumingAfterRestart : RUN_STATUS_TEXT.starting,
        signal,
      });
      const finalRun = this.runs.get(params.runId);
      if (!this.runQueue || !finalRun) {
        return;
      }
      if (finalRun.status === "completed") {
        this.runQueue.complete(params.runId);
        return;
      }
      this.runQueue.fail(params.runId, finalRun.errorMessage ?? finalRun.status);
    }).catch((error) => {
      this.runQueue?.fail(params.runId, getErrorMessage(error));
      this.logger.error({ error, runId: params.runId }, "Queued run failed.");
    });
  }

  private async execute(params: {
    event: InboundEvent;
    session: SessionRoute;
    runId: string;
    placeholderText: string;
    signal: AbortSignal;
  }): Promise<void> {
    const run = this.runs.get(params.runId);
    if (!run) {
      throw new Error(`Unknown queued run ${params.runId}.`);
    }
    let placeholder = await this.outbox.start({
      runId: run.runId,
      chatId: params.event.chatId,
      threadId: params.event.threadId,
      replyToMessageId: params.event.messageId,
      placeholderText: params.placeholderText,
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
    let attachmentPreparation: AttachmentPreparation | undefined;
    let attachmentCleaned = false;
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
      this.runs.update(run.runId, {
        status: "starting",
        startedAt: this.clock.now(),
      });
      const auth = await this.tokenResolver.resolve(params.session.profileId);
      attachmentPreparation = await this.attachments.prepare({
        attachments: params.event.attachments,
        allowNativeImages: this.modelCapabilities.supportsNativeImageInput(params.session.modelRef),
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
      const includeAdminTools = Boolean(
        params.event.fromUserId && this.config.telegram.adminUserIds.includes(params.event.fromUserId),
      );
      const callerRole: ToolCallerRole = includeAdminTools ? "admin" : "user";
      const toolDeclarations =
        this.toolRegistry && this.toolExecutor
          ? this.toolRegistry.listModelDeclarations({
              includeAdminTools,
              filter: (definition) =>
                this.toolPolicy?.evaluate(definition, {
                  role: callerRole,
                  chatId: params.event.chatId,
                }).allowed ?? true,
            })
          : undefined;
      const extraContextMessages: ProviderMessage[] = [];
      const executedToolResults: ToolExecutionResult[] = [];
      let result: ModelStreamResult | undefined;
      let toolRounds = 0;
      let totalToolCalls = 0;

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
            placeholder = await this.outbox.update(placeholder, nextText);
          },
          onThinkingDelta: async (delta) => {
            collector.appendThinking(delta);
          },
          onToolCallStart: async (toolCall) => {
            if (toolCall.name) {
              placeholder = await this.outbox.update(placeholder, formatToolPreparingStatus(toolCall.name));
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
          placeholder = await this.outbox.update(placeholder, formatToolRunningStatus(toolCall.name));
          const execution = await this.toolExecutor.execute(toolCall, {
            signal: params.signal,
            sessionKey: params.session.sessionKey,
            runId: run.runId,
            requestedByUserId: params.event.fromUserId,
            chatId: params.event.chatId,
          });
          executedToolResults.push(execution);
          this.transcripts.add({
            sessionKey: params.session.sessionKey,
            runId: run.runId,
            role: "tool",
            contentText: toolTranscriptText(execution),
            contentJson: toolTranscriptJson(toolCall, execution),
          });
          extraContextMessages.push(this.toolExecutor.toToolResultMessage(execution));
          placeholder = await this.outbox.update(
            placeholder,
            formatToolCompletedStatus({ toolName: execution.toolName, isError: execution.isError }),
          );
          this.logger.info(
            {
              runId: run.runId,
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
        }
      }
      if (!result) {
        throw new Error("No model response was produced.");
      }
      const finalText = result.text.trim() || collector.getText().trim();
      const visibleText = finalText || "No response generated.";
      const delivery = await this.outbox.finish(placeholder, visibleText);
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
      const errorCode = params.signal.aborted ? "cancelled" : "run_failed";
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
      await this.outbox.fail(placeholder, formatRunFailedStatus(message));
      await this.removeAckReactionAfterReply(params.event);
      this.runs.update(run.runId, {
        status: params.signal.aborted ? "cancelled" : "failed",
        errorCode,
        errorMessage: message,
        finishedAt: this.clock.now(),
      });
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

  private async proposeMemoryCandidates(params: {
    session: SessionRoute;
    auth: Awaited<ReturnType<ModelTokenResolver["resolve"]>>;
    signal: AbortSignal;
  }): Promise<void> {
    if (!this.config.memory.candidateExtractionEnabled || !this.memories) {
      return;
    }
    const extractionPrompt = buildMemoryCandidateExtractionPrompt({
      messages: this.transcripts.listRecent(
        params.session.sessionKey,
        this.config.memory.candidateRecentMessages,
      ),
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
    let parsed: Partial<InboundEvent> = {};
    try {
      parsed = record.eventJson ? (JSON.parse(record.eventJson) as Partial<InboundEvent>) : {};
    } catch {
      parsed = {};
    }
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
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
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
        await this.outbox.fail(handle, formatRunFailedStatus(message));
      })
      .catch((error) => {
        this.logger.warn({ error, runId: record.runId }, "Failed to notify chat about unrecoverable queued run.");
      });
  }
}
