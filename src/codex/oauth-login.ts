import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import open from "open";
import type { AppConfig } from "../app/config.js";
import type { Logger } from "../shared/logger.js";
import type { AuthProfileStore } from "./auth-store.js";
import { resolveCodexAuthIdentity } from "./cli-auth-import.js";

const OPENAI_CODEX_OAUTH_REQUIRED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "model.request",
  "api.responses.write",
] as const;

function normalizeOpenAICodexAuthorizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return rawUrl;
  }
  try {
    const url = new URL(trimmed);
    if (!/(?:^|\.)openai\.com$/i.test(url.hostname) || !/\/oauth\/authorize\/?$/i.test(url.pathname)) {
      return rawUrl;
    }
    const existing = new Set(
      (url.searchParams.get("scope") ?? "")
        .split(/\s+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    );
    for (const scope of OPENAI_CODEX_OAUTH_REQUIRED_SCOPES) {
      existing.add(scope);
    }
    url.searchParams.set("scope", Array.from(existing).join(" "));
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/** Runs an interactive OpenAI Codex OAuth login and stores the resulting profile credentials. */
export async function runCodexOAuthLogin(params: {
  config: AppConfig;
  authStore: AuthProfileStore;
  logger: Logger;
  profileId?: string;
}): Promise<string> {
  const { loginOpenAICodex } = await import("@mariozechner/pi-ai/oauth");
  const profileId = params.profileId ?? params.config.auth.defaultProfile;
  const rl = readline.createInterface({ input, output });
  try {
    params.logger.info("Starting OpenAI Codex OAuth.");
    const creds = await loginOpenAICodex({
      originator: "mottbot",
      onAuth: async (event: { url: string }) => {
        const url = normalizeOpenAICodexAuthorizeUrl(event.url);
        params.logger.info({ url }, "Opening OAuth URL.");
        output.write(`\nOpen this URL in your browser if it does not open automatically:\n\n${url}\n\n`);
        await open(url).catch(() => undefined);
      },
      onPrompt: async (prompt: { message: string; placeholder?: string }) =>
        await rl.question(`${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `),
      onManualCodeInput: async () => await rl.question("Paste the authorization code or full redirect URL: "),
      onProgress: (message: string) => params.logger.info({ message }, "OAuth progress"),
    });
    if (!creds) {
      throw new Error("OAuth login did not return credentials.");
    }
    const identity = resolveCodexAuthIdentity(creds.access);
    params.authStore.upsert({
      profileId,
      source: "local_oauth",
      accessToken: creds.access,
      refreshToken: creds.refresh,
      expiresAt: creds.expires,
      accountId: typeof creds.accountId === "string" ? creds.accountId : undefined,
      email: identity.email,
      displayName: identity.displayName,
      metadata: {
        source: "loginOpenAICodex",
        callbackHost: params.config.oauth.callbackHost,
        callbackPort: params.config.oauth.callbackPort,
      },
    });
    return profileId;
  } finally {
    rl.close();
  }
}
