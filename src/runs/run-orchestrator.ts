import type { AppConfig } from "../app/config.js";
import type { CodexTokenResolver } from "../codex/token-resolver.js";
import type { CodexTransport } from "../codex/transport.js";
import { getErrorMessage } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import type { SessionQueue } from "../sessions/queue.js";
import type { SessionRoute } from "../sessions/types.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { VectorMemoryStore } from "../sessions/vector-memory-store.js";
import type { InboundEvent } from "../telegram/types.js";
import type { TelegramOutbox } from "../telegram/outbox.js";
import { buildPrompt } from "./prompt-builder.js";
import type { RunStore } from "./run-store.js";
import { StreamCollector } from "./stream-collector.js";
import { UsageRecorder } from "./usage-recorder.js";

function buildUserTranscriptPayload(event: InboundEvent): {
  contentText?: string;
  contentJson?: string;
} {
  const visibleText = event.text ?? event.caption;
  const normalizedText = visibleText?.trim();
  const hasAttachments = event.attachments.length > 0;
  const contentText = normalizedText || (hasAttachments ? "Shared attachments." : undefined);
  const contentJson = hasAttachments
    ? JSON.stringify({
        attachments: event.attachments,
      })
    : undefined;
  return {
    ...(contentText ? { contentText } : {}),
    ...(contentJson ? { contentJson } : {}),
  };
}

function buildMemoryQuery(event: InboundEvent): string {
  const eventText = event.text ?? event.caption;
  const normalized = eventText?.trim();
  if (normalized) {
    return normalized;
  }
  return event.attachments.length > 0 ? "Shared attachments." : "";
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
    private readonly memory: VectorMemoryStore,
    private readonly logger: Logger,
  ) {
    this.usageRecorder = new UsageRecorder(this.runs);
  }

  async enqueueMessage(params: { event: InboundEvent; session: SessionRoute }): Promise<void> {
    const userPayload = buildUserTranscriptPayload(params.event);
    if (!userPayload.contentText) {
      return;
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
    });

    this.transcripts.add({
      sessionKey: params.session.sessionKey,
      role: "user",
      contentText: userPayload.contentText,
      contentJson: userPayload.contentJson,
      telegramMessageId: params.event.messageId,
      replyToTelegramMessageId: params.event.replyToMessageId,
    });

    const run = this.runs.create({
      sessionKey: params.session.sessionKey,
      modelRef: params.session.modelRef,
      profileId: params.session.profileId,
    });

    void this.queue.enqueue(params.session.sessionKey, async (signal) => {
      await this.execute({
        event: params.event,
        session: params.session,
        runId: run.runId,
        signal,
      });
    }).catch((error) => {
      this.logger.error({ error, runId: run.runId }, "Queued run failed.");
    });
  }

  async stop(sessionKey: string): Promise<boolean> {
    return this.queue.cancel(sessionKey);
  }

  private async execute(params: {
    event: InboundEvent;
    session: SessionRoute;
    runId: string;
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
      placeholderText: "Working...",
    });

    try {
      this.runs.update(run.runId, {
        status: "starting",
        startedAt: Date.now(),
      });
      const auth = await this.tokenResolver.resolve(params.session.profileId);
      const history = this.transcripts.listRecent(params.session.sessionKey, 30);
      const recalledMemories = this.memory.search({
        sessionKey: params.session.sessionKey,
        query: buildMemoryQuery(params.event),
        limit: 4,
        excludeMessageIds: history.map((entry) => entry.id),
      });
      const prompt = buildPrompt({
        history,
        systemPrompt: params.session.systemPrompt,
        recalledMemories,
      });
      const collector = new StreamCollector();
      const result = await this.transport.stream({
        sessionKey: params.session.sessionKey,
        modelRef: params.session.modelRef,
        transport: this.config.models.transport,
        auth,
        systemPrompt: prompt.systemPrompt,
        messages: prompt.messages,
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
        finishedAt: Date.now(),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      this.logger.error({ error }, "Run execution failed.");
      await this.outbox.fail(placeholder, `Run failed: ${message}`);
      this.runs.update(run.runId, {
        status: params.signal.aborted ? "cancelled" : "failed",
        errorCode: params.signal.aborted ? "cancelled" : "run_failed",
        errorMessage: message,
        finishedAt: Date.now(),
      });
    }
  }
}
