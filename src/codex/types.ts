export type AuthProfileSource = "local_oauth" | "codex_cli";

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

export type CodexResolvedAuth = {
  profile: AuthProfile;
  accessToken: string;
  apiKey: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
};

export type CodexUsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type CodexUsageSnapshot = {
  provider: "openai-codex";
  displayName: string;
  windows: CodexUsageWindow[];
  plan?: string;
};
