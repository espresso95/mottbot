import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexTokenResolver } from "../../src/codex/token-resolver.js";
import { createStores } from "../helpers/fakes.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

const getOAuthApiKey = vi.fn();
const getOAuthProviders = vi.fn();
const refreshOpenAICodexToken = vi.fn();

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey,
  getOAuthProviders,
  refreshOpenAICodexToken,
}));

function fakeJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("CodexTokenResolver", () => {
  const cleanup: Array<() => void> = [];
  const previousEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    getOAuthProviders.mockReturnValue([{ id: "openai-codex" }]);
    getOAuthApiKey.mockResolvedValue({ apiKey: "oauth-api-key" });
  });

  afterEach(() => {
    process.env = { ...previousEnv };
    vi.restoreAllMocks();
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("resolves a valid profile without refreshing", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "local_oauth",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
    });
    const resolver = new CodexTokenResolver(stores.authProfiles, stores.logger);
    const result = await resolver.resolve("openai-codex:default");
    expect(result.accessToken).toBe("access");
    expect(result.apiKey).toBe("oauth-api-key");
    expect(refreshOpenAICodexToken).not.toHaveBeenCalled();
  });

  it("refreshes expired profiles only once under concurrency", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "local_oauth",
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: Date.now() - 1000,
    });
    refreshOpenAICodexToken.mockImplementation(
      async () =>
        await new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                access: "access-new",
                refresh: "refresh-new",
                expires: Date.now() + 3600_000,
              }),
            20,
          ),
        ),
    );
    const resolver = new CodexTokenResolver(stores.authProfiles, stores.logger);
    const [a, b] = await Promise.all([
      resolver.resolve("openai-codex:default"),
      resolver.resolve("openai-codex:default"),
    ]);
    expect(refreshOpenAICodexToken).toHaveBeenCalledTimes(1);
    expect(a.accessToken).toBe("access-new");
    expect(b.accessToken).toBe("access-new");
    expect(stores.authProfiles.get("openai-codex:default")?.refreshToken).toBe("refresh-new");
  });

  it("fails expired profiles that cannot refresh", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "local_oauth",
      accessToken: "access-old",
      expiresAt: Date.now() - 1000,
    });

    const resolver = new CodexTokenResolver(stores.authProfiles, stores.logger);

    await expect(resolver.resolve("openai-codex:default")).rejects.toThrow("does not contain a refresh token");
    expect(refreshOpenAICodexToken).not.toHaveBeenCalled();
  });

  it("keeps existing credentials when refresh fails", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    stores.authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "local_oauth",
      accessToken: "access-old",
      refreshToken: "refresh-old",
      expiresAt: Date.now() - 1000,
    });
    refreshOpenAICodexToken.mockRejectedValueOnce(new Error("refresh unavailable"));

    const resolver = new CodexTokenResolver(stores.authProfiles, stores.logger);

    await expect(resolver.resolve("openai-codex:default")).rejects.toThrow("refresh unavailable");
    expect(stores.authProfiles.get("openai-codex:default")?.accessToken).toBe("access-old");
    expect(stores.authProfiles.get("openai-codex:default")?.refreshToken).toBe("refresh-old");
  });

  it("keeps refreshed CLI credentials when auth file write-back fails", async () => {
    const stores = createStores();
    const codexHome = createTempDir();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
      removeTempDir(codexHome);
    });
    process.env.CODEX_HOME = codexHome;
    const accessOld = fakeJwt({ exp: Math.floor((Date.now() - 1000) / 1000) });
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessOld,
          refresh_token: "refresh-old",
        },
      }),
    );
    stores.authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "codex_cli",
      accessToken: accessOld,
      refreshToken: "refresh-old",
      expiresAt: Date.now() - 1000,
    });
    refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "access-new",
      refresh: "refresh-new",
      expires: Date.now() + 3600_000,
    });
    const writeBack = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("read-only auth file");
    });

    const resolver = new CodexTokenResolver(stores.authProfiles, stores.logger);
    const result = await resolver.resolve("openai-codex:default");

    expect(writeBack).toHaveBeenCalled();
    expect(result.accessToken).toBe("access-new");
    expect(stores.authProfiles.get("openai-codex:default")?.refreshToken).toBe("refresh-new");
  });
});
