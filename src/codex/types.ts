/** Source that created or last refreshed a Codex auth profile. */
export type AuthProfileSource = "local_oauth" | "codex_cli";

/** Persisted subscription-backed Codex credentials and display metadata. */
export type AuthProfile = {
  profileId: string;
  provider: "openai-codex";
  source: AuthProfileSource;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  email?: string;
  displayName?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

/** Access material selected for one Codex run after profile lookup and refresh. */
export type CodexResolvedAuth = {
  profile: AuthProfile;
  accessToken: string;
  apiKey: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
};

/** One usage-limit window returned by the Codex subscription backend. */
export type CodexUsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

/** User-visible usage status for the configured Codex subscription profile. */
export type CodexUsageSnapshot = {
  provider: "openai-codex";
  displayName: string;
  windows: CodexUsageWindow[];
  plan?: string;
};
