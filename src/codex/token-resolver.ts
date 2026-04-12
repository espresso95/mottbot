import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../shared/logger.js";
import type { AuthProfileStore } from "./auth-store.js";
import {
  importCodexCliAuthProfile,
  readCodexCliAuthFile,
  resolveCodexCliHome,
  resolveCodexAccessTokenExpiry,
  resolveCodexAuthIdentity,
} from "./cli-auth-import.js";
import type { AuthProfile, CodexResolvedAuth } from "./types.js";

function isOauthProvider(provider: string, available: unknown): boolean {
  return Array.isArray(available)
    ? available.some(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          "id" in entry &&
          typeof (entry as { id?: unknown }).id === "string" &&
          (entry as { id: string }).id === provider,
      )
    : false;
}

async function buildOAuthApiKey(profile: AuthProfile): Promise<string> {
  const oauth = await import("@mariozechner/pi-ai/oauth");
  if (!profile.accessToken) {
    throw new Error("Missing access token.");
  }
  if (!profile.refreshToken) {
    return profile.accessToken;
  }
  const providers = typeof oauth.getOAuthProviders === "function" ? oauth.getOAuthProviders() : [];
  if (!isOauthProvider(profile.provider, providers) || typeof oauth.getOAuthApiKey !== "function") {
    return profile.accessToken;
  }
  const result = await oauth.getOAuthApiKey(profile.provider, {
    [profile.provider]: {
      access: profile.accessToken,
      refresh: profile.refreshToken,
      expires: profile.expiresAt ?? 0,
      ...(profile.accountId ? { accountId: profile.accountId } : {}),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
    },
  });
  return typeof result?.apiKey === "string" && result.apiKey.length > 0 ? result.apiKey : profile.accessToken;
}

function shouldRefresh(profile: AuthProfile): boolean {
  return typeof profile.expiresAt === "number" && profile.expiresAt <= Date.now() + 60_000;
}

export class CodexTokenResolver {
  private readonly locks = new Map<string, Promise<CodexResolvedAuth>>();

  constructor(
    private readonly authStore: AuthProfileStore,
    private readonly logger: Logger,
  ) {}

  async resolve(profileId: string): Promise<CodexResolvedAuth> {
    const existing = this.authStore.get(profileId);
    if (!existing) {
      throw new Error(`Unknown auth profile ${profileId}.`);
    }
    if (existing.source === "codex_cli") {
      importCodexCliAuthProfile({ store: this.authStore, profileId });
    }
    const current = this.authStore.get(profileId);
    if (!current?.accessToken) {
      throw new Error(`Profile ${profileId} does not contain an access token.`);
    }
    if (!shouldRefresh(current) || !current.refreshToken) {
      return {
        profile: current,
        accessToken: current.accessToken,
        apiKey: await buildOAuthApiKey(current),
        refreshToken: current.refreshToken,
        expiresAt: current.expiresAt,
        accountId: current.accountId,
      };
    }
    return await this.refreshWithLock(current);
  }

  private async refreshWithLock(profile: AuthProfile): Promise<CodexResolvedAuth> {
    const existingLock = this.locks.get(profile.profileId);
    if (existingLock) {
      return await existingLock;
    }
    const task = this.doRefresh(profile).finally(() => {
      if (this.locks.get(profile.profileId) === task) {
        this.locks.delete(profile.profileId);
      }
    });
    this.locks.set(profile.profileId, task);
    return await task;
  }

  private async doRefresh(profile: AuthProfile): Promise<CodexResolvedAuth> {
    if (!profile.refreshToken) {
      throw new Error(`Profile ${profile.profileId} cannot be refreshed.`);
    }
    const oauth = await import("@mariozechner/pi-ai/oauth");
    if (typeof oauth.refreshOpenAICodexToken !== "function") {
      throw new Error("refreshOpenAICodexToken is not available in @mariozechner/pi-ai/oauth.");
    }
    this.logger.info({ profileId: profile.profileId, source: profile.source }, "Refreshing Codex OAuth token.");
    const refreshed = await oauth.refreshOpenAICodexToken(profile.refreshToken);
    this.authStore.upsert({
      profileId: profile.profileId,
      source: profile.source,
      accessToken: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expires,
      accountId:
        typeof refreshed.accountId === "string" && refreshed.accountId.trim().length > 0
          ? refreshed.accountId
          : profile.accountId,
      email: profile.email ?? resolveCodexAuthIdentity(refreshed.access).email,
      displayName: profile.displayName ?? resolveCodexAuthIdentity(refreshed.access).displayName,
      metadata: profile.metadata,
    });
    if (profile.source === "codex_cli") {
      this.writeBackCodexCliAuth(refreshed);
      importCodexCliAuthProfile({ store: this.authStore, profileId: profile.profileId });
    }
    const next = this.authStore.get(profile.profileId);
    if (!next?.accessToken) {
      throw new Error(`Profile ${profile.profileId} became invalid after refresh.`);
    }
    return {
      profile: next,
      accessToken: next.accessToken,
      apiKey: await buildOAuthApiKey(next),
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
      accountId: next.accountId,
    };
  }

  private writeBackCodexCliAuth(refreshed: {
    access: string;
    refresh: string;
    expires: number;
    accountId?: string;
  }): void {
    const authFile = readCodexCliAuthFile();
    if (!authFile || authFile.auth_mode !== "chatgpt") {
      return;
    }
    const authPath = path.join(resolveCodexCliHome(process.env), "auth.json");
    try {
      const next = {
        ...authFile,
        auth_mode: "chatgpt",
        tokens: {
          ...(authFile.tokens && typeof authFile.tokens === "object" ? authFile.tokens : {}),
          access_token: refreshed.access,
          refresh_token: refreshed.refresh,
          ...(refreshed.accountId ? { account_id: refreshed.accountId } : {}),
        },
        last_refresh: new Date().toISOString(),
      };
      fs.writeFileSync(authPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    } catch (error) {
      this.logger.warn({ error }, "Failed to write refreshed credentials back to Codex CLI auth file.");
    }
  }
}
