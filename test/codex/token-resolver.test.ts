import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexTokenResolver } from "../../src/codex/token-resolver.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

const getOAuthApiKey = vi.fn();
const getOAuthProviders = vi.fn();
const refreshOpenAICodexToken = vi.fn();

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey,
  getOAuthProviders,
  refreshOpenAICodexToken,
}));

describe("CodexTokenResolver", () => {
  const cleanup: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    getOAuthProviders.mockReturnValue([{ id: "openai-codex" }]);
    getOAuthApiKey.mockResolvedValue({ apiKey: "oauth-api-key" });
  });

  afterEach(() => {
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
});
