import type { AppConfig } from "../app/config.js";
import { supportsNativeImageInput } from "../codex/provider.js";
import type { CodexTokenResolver } from "../codex/token-resolver.js";
import type { CodexTransport } from "../codex/transport.js";
import type { Clock } from "../shared/clock.js";
import { getErrorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { SessionQueue } from "../sessions/queue.js";
import type { SessionRoute } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { InboundEvent } from "../telegram/types.js";
import type { TelegramOutbox } from "../telegram/outbox.js";
import {
  NoopAttachmentIngestor,
  type AttachmentIngestor,
  type AttachmentPreparation,
  type TranscriptAttachmentMetadata,
} from "../telegram/attachments.js";
import { appendNativeAttachmentsToLatestUserMessage } from "./attachment-inputs.js";
import { buildPrompt } from "./prompt-builder.js";
import type { RunQueueRecord, RunQueueStore } from "./run-queue-store.js";
import type { RunStore } from "./run-store.js";
import { StreamCollector } from "./stream-collector.js";
import { UsageRecorder } from "./usage-recorder.js";

const RUN_QUEUE_LEASE_MS = 10 * 60 * 1000;

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

export class RunOrchestrator {
  private readonly usageRecorder: UsageRecorder;

  constructor(
    private readonly config: AppConfig,
    private readonly queue: SessionQueue,
    private readonly sessions: SessionStore,
    private readonly transcripts: TranscriptStore,
    private readonly runs: RunStore,
    private readonly tokenResolver: CodexTokenResolver,
    private readonly transport: CodexTransport,
    private readonly outbox: TelegramOutbox,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly attachments: AttachmentIngestor = new NoopAttachmentIngestor(),
    private readonly runQueue?: RunQueueStore,
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
        placeholderText: params.recovered ? "Resuming queued request after restart..." : "Working...",
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
        allowNativeImages: supportsNativeImageInput(params.session.modelRef),
        signal: params.signal,
      });
      if (params.event.attachments.length > 0) {
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
      });
      const messages = appendNativeAttachmentsToLatestUserMessage({
        messages: prompt.messages,
        nativeInputs: attachmentPreparation.nativeInputs,
      });
      await cleanupAttachments();
      const collector = new StreamCollector();
      const result = await this.transport.stream({
        sessionKey: params.session.sessionKey,
        modelRef: params.session.modelRef,
        transport: this.config.models.transport,
        auth,
        systemPrompt: prompt.systemPrompt,
        messages,
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
      });
      const finalText = (result.text || collector.getText()).trim();
      const visibleText = finalText || "No response generated.";
      const delivery = await this.outbox.finish(placeholder, visibleText);
      this.transcripts.add({
        sessionKey: params.session.sessionKey,
        runId: run.runId,
        role: "assistant",
        contentText: visibleText,
        telegramMessageId: delivery.primaryMessageId,
        contentJson:
          result.thinking || delivery.continuationMessageIds.length > 0
            ? JSON.stringify({
                ...(result.thinking ? { thinking: result.thinking } : {}),
                ...(delivery.continuationMessageIds.length > 0
                  ? { continuationMessageIds: delivery.continuationMessageIds }
                  : {}),
              })
            : undefined,
      });
      this.usageRecorder.record(run.runId, result.usage);
      this.runs.update(run.runId, {
        status: "completed",
        transport: result.transport,
        requestIdentity: result.requestIdentity,
        finishedAt: this.clock.now(),
      });
    } catch (error) {
      await cleanupAttachments();
      const message = getErrorMessage(error);
      this.logger.error({ error }, "Run execution failed.");
      await this.outbox.fail(placeholder, `Run failed: ${message}`);
      this.runs.update(run.runId, {
        status: params.signal.aborted ? "cancelled" : "failed",
        errorCode: params.signal.aborted ? "cancelled" : "run_failed",
        errorMessage: message,
        finishedAt: this.clock.now(),
      });
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
        placeholderText: "Unable to resume queued request after restart.",
      })
      .then(async (handle) => {
        await this.outbox.fail(handle, `Run failed: ${message}`);
      })
      .catch((error) => {
        this.logger.warn({ error, runId: record.runId }, "Failed to notify chat about unrecoverable queued run.");
      });
  }
}
