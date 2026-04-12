import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCodexOAuthLogin } from "../../src/codex/oauth-login.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

const {
  loginOpenAICodex,
  openMock,
  questionMock,
  closeMock,
} = vi.hoisted(() => ({
  loginOpenAICodex: vi.fn(),
  openMock: vi.fn(async () => undefined),
  questionMock: vi.fn(async () => "code"),
  closeMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  loginOpenAICodex,
}));

vi.mock("open", () => ({
  default: openMock,
}));

vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: () => ({
      question: questionMock,
      close: closeMock,
    }),
  },
}));

function createJwt(expSeconds: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    exp: expSeconds,
    "https://api.openai.com/profile": { email: "user@example.com" },
  })}.sig`;
}

describe("runCodexOAuthLogin", () => {
  const cleanup: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("stores OAuth credentials and opens a normalized auth URL", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });

    loginOpenAICodex.mockImplementation(async (params: any) => {
      await params.onAuth({ url: "https://auth.openai.com/oauth/authorize?scope=openid" });
      return {
        access: createJwt(1_900_000_000),
        refresh: "refresh",
        expires: 1_900_000_000_000,
        accountId: "acct-1",
      };
    });

    const profileId = await runCodexOAuthLogin({
      config: stores.config,
      authStore: stores.authProfiles,
      logger: stores.logger,
    });

    expect(profileId).toBe("openai-codex:default");
    expect(openMock).toHaveBeenCalledWith(
      expect.stringContaining("api.responses.write"),
    );
    expect(stores.authProfiles.get(profileId)).toMatchObject({
      source: "local_oauth",
      accountId: "acct-1",
      email: "user@example.com",
    });
    expect(closeMock).toHaveBeenCalled();
  });
});
