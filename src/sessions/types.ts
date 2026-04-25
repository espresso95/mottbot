/** Session routing mode derived from Telegram chat and binding context. */
export type SessionRouteMode = "dm" | "group" | "topic" | "bound";

/** Persisted routing and model configuration for a Telegram conversation scope. */
export type SessionRoute = {
  sessionKey: string;
  chatId: string;
  threadId?: number;
  userId?: string;
  routeMode: SessionRouteMode;
  boundName?: string;
  projectKey?: string;
  agentId: string;
  profileId: string;
  modelRef: string;
  fastMode: boolean;
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
};

/** Role labels used for transcript persistence and prompt reconstruction. */
export type TranscriptMessageRole = "user" | "assistant" | "system" | "tool";

/** Persisted transcript entry for user, assistant, system, or tool content. */
export type TranscriptMessage = {
  id: string;
  sessionKey: string;
  runId?: string;
  role: TranscriptMessageRole;
  telegramMessageId?: number;
  replyToTelegramMessageId?: number;
  contentText?: string;
  contentJson?: string;
  createdAt: number;
};

/** Lifecycle status for a model run. */
export type RunStatus = "queued" | "starting" | "streaming" | "completed" | "failed" | "cancelled";

/** Persisted run metadata shared by stores, diagnostics, and orchestration. */
export type RunRecord = {
  runId: string;
  sessionKey: string;
  agentId: string;
  status: RunStatus;
  modelRef: string;
  profileId: string;
  transport?: string;
  requestIdentity?: string;
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
  errorMessage?: string;
  usageJson?: string;
  createdAt: number;
  updatedAt: number;
};
