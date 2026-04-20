export type SessionRouteMode = "dm" | "group" | "topic" | "bound";

export type SessionRoute = {
  sessionKey: string;
  chatId: string;
  threadId?: number;
  userId?: string;
  routeMode: SessionRouteMode;
  boundName?: string;
  agentId: string;
  profileId: string;
  modelRef: string;
  fastMode: boolean;
  systemPrompt?: string;
  createdAt: number;
  updatedAt: number;
};

export type TranscriptMessageRole = "user" | "assistant" | "system" | "tool";

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

export type RunStatus = "queued" | "starting" | "streaming" | "completed" | "failed" | "cancelled";

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
