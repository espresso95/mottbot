import fs from "node:fs";
import path from "node:path";
import { resolveRequiredHomeDir } from "./path-helpers.js";
import type { AuthProfileStore } from "./auth-store.js";

type CodexCliAuthFile = {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    account_id?: unknown;
  };
};

function trimNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Decodes the unsigned JWT payload from a Codex access token for local metadata extraction. */
function decodeCodexJwtPayload(accessToken: string): Record<string, unknown> | null {
  const parts = accessToken.split(".");
  const payloadSegment = parts[1];
  if (parts.length !== 3 || !payloadSegment) {
    return null;
  }
  try {
    const decoded = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Resolves the access-token expiry timestamp in milliseconds when the JWT exposes an exp claim. */
export function resolveCodexAccessTokenExpiry(accessToken: string): number | undefined {
  const payload = decodeCodexJwtPayload(accessToken);
  const exp = payload?.exp;
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
    return Math.trunc(exp) * 1000;
  }
  if (typeof exp === "string" && /^\d+$/.test(exp.trim())) {
    return Number.parseInt(exp.trim(), 10) * 1000;
  }
  return undefined;
}

/** Extracts display identity fields from the Codex access token profile claim. */
export function resolveCodexAuthIdentity(accessToken: string): {
  email?: string;
  displayName?: string;
} {
  const payload = decodeCodexJwtPayload(accessToken);
  const profile =
    payload?.["https://api.openai.com/profile"] && typeof payload["https://api.openai.com/profile"] === "object"
      ? (payload["https://api.openai.com/profile"] as Record<string, unknown>)
      : undefined;
  const email = trimNonEmptyString(profile?.email);
  if (email) {
    return { email, displayName: email };
  }
  return {};
}

/** Resolves the Codex CLI home directory from CODEX_HOME using shell-style home expansion. */
export function resolveCodexCliHome(env: NodeJS.ProcessEnv): string {
  const configured = trimNonEmptyString(env.CODEX_HOME);
  if (!configured) {
    return path.join(resolveRequiredHomeDir(), ".codex");
  }
  if (configured === "~") {
    return resolveRequiredHomeDir();
  }
  if (configured.startsWith("~/")) {
    return path.join(resolveRequiredHomeDir(), configured.slice(2));
  }
  return path.resolve(configured);
}

/** Reads the Codex CLI auth file, returning null when it is absent or invalid JSON. */
export function readCodexCliAuthFile(env: NodeJS.ProcessEnv = process.env): CodexCliAuthFile | null {
  try {
    const authPath = path.join(resolveCodexCliHome(env), "auth.json");
    const raw = fs.readFileSync(authPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Imports ChatGPT-mode Codex CLI credentials into the configured auth profile store. */
export function importCodexCliAuthProfile(params: {
  store: AuthProfileStore;
  profileId?: string;
  env?: NodeJS.ProcessEnv;
}): { profileId: string; imported: boolean } {
  const authFile = readCodexCliAuthFile(params.env ?? process.env);
  if (authFile?.auth_mode !== "chatgpt") {
    return {
      profileId: params.profileId ?? "openai-codex:default",
      imported: false,
    };
  }
  const accessToken = trimNonEmptyString(authFile.tokens?.access_token);
  const refreshToken = trimNonEmptyString(authFile.tokens?.refresh_token);
  if (!accessToken || !refreshToken) {
    return {
      profileId: params.profileId ?? "openai-codex:default",
      imported: false,
    };
  }
  const accountId = trimNonEmptyString(authFile.tokens?.account_id);
  const identity = resolveCodexAuthIdentity(accessToken);
  const profileId = params.profileId ?? "openai-codex:default";
  params.store.upsert({
    profileId,
    source: "codex_cli",
    accessToken,
    refreshToken,
    expiresAt: resolveCodexAccessTokenExpiry(accessToken),
    accountId,
    email: identity.email,
    displayName: identity.displayName,
    metadata: {
      codexHome: resolveCodexCliHome(params.env ?? process.env),
      importedAt: new Date().toISOString(),
    },
  });
  return { profileId, imported: true };
}
