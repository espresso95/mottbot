import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramCommandRouter } from "../../src/telegram/commands.js";
import { RouteResolver } from "../../src/telegram/route-resolver.js";
import { createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

vi.mock("../../src/codex/usage.js", () => ({
  fetchCodexUsage: vi.fn(async () => ({
    provider: "openai-codex",
    displayName: "OpenAI Codex",
    windows: [{ label: "3h", usedPercent: 20 }],
  })),
}));

vi.mock("../../src/codex/cli-auth-import.js", () => ({
  importCodexCliAuthProfile: vi.fn(() => ({ profileId: "openai-codex:default", imported: true })),
}));

describe("TelegramCommandRouter", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles /model and updates the session", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const router = new TelegramCommandRouter(
      api as any,
      stores.config,
      new RouteResolver(stores.config, stores.sessions),
      stores.sessions,
      stores.transcripts,
      stores.authProfiles,
      { resolve: vi.fn() } as any,
      { stop: vi.fn(async () => false) } as any,
      stores.health,
    );

    const handled = await router.maybeHandle(
      createInboundEvent({ text: "/model openai-codex/gpt-5.4-mini", isCommand: true }),
    );
    expect(handled).toBe(true);
    const session = stores.sessions.findByChat("chat-1");
    expect(session?.modelRef).toBe("openai-codex/gpt-5.4-mini");
    expect(api.sendMessage).toHaveBeenCalled();
  });

  it("handles /status with usage data", async () => {
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
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const router = new TelegramCommandRouter(
      api as any,
      stores.config,
      new RouteResolver(stores.config, stores.sessions),
      stores.sessions,
      stores.transcripts,
      stores.authProfiles,
      { resolve: vi.fn(async () => ({ accessToken: "access", apiKey: "access", profile: stores.authProfiles.get("openai-codex:default")! })) } as any,
      { stop: vi.fn(async () => false) } as any,
      stores.health,
    );

    await router.maybeHandle(createInboundEvent({ text: "/status", isCommand: true }));
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Usage: 3h: 20%"),
      expect.any(Object),
    );
  });

  it("handles /stop and /auth import-cli", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const orchestrator = { stop: vi.fn(async () => true) };
    const router = new TelegramCommandRouter(
      api as any,
      stores.config,
      new RouteResolver(stores.config, stores.sessions),
      stores.sessions,
      stores.transcripts,
      stores.authProfiles,
      { resolve: vi.fn() } as any,
      orchestrator as any,
      stores.health,
    );

    await router.maybeHandle(createInboundEvent({ text: "/stop", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/auth import-cli", isCommand: true }));

    expect(orchestrator.stop).toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("handles /profile list, /fast, /reset, /bind, /unbind, and auth helpers", async () => {
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
      email: "user@example.com",
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const router = new TelegramCommandRouter(
      api as any,
      stores.config,
      new RouteResolver(stores.config, stores.sessions),
      stores.sessions,
      stores.transcripts,
      stores.authProfiles,
      { resolve: vi.fn() } as any,
      { stop: vi.fn(async () => false) } as any,
      stores.health,
    );

    await router.maybeHandle(createInboundEvent({ text: "/profile", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/fast on", isCommand: true }));
    stores.transcripts.add({
      sessionKey: "tg:dm:chat-1:user:user-1",
      role: "user",
      contentText: "hello",
    });
    await router.maybeHandle(createInboundEvent({ text: "/reset", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/bind ops", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/unbind", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/auth status", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/auth login", isCommand: true }));

    const session = stores.sessions.findByChat("chat-1");
    expect(session?.fastMode).toBe(true);
    expect(session?.routeMode).toBe("dm");
    expect(stores.transcripts.listRecent("tg:dm:chat-1:user:user-1")).toEqual([]);
    expect(api.sendMessage).toHaveBeenCalledTimes(7);
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("openai-codex:default"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Run `pnpm auth:login`"),
      expect.any(Object),
    );
  });

  it("rejects selecting an unknown profile", async () => {
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
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const router = new TelegramCommandRouter(
      api as any,
      stores.config,
      new RouteResolver(stores.config, stores.sessions),
      stores.sessions,
      stores.transcripts,
      stores.authProfiles,
      { resolve: vi.fn() } as any,
      { stop: vi.fn(async () => false) } as any,
      stores.health,
    );

    await router.maybeHandle(createInboundEvent({ text: "/profile does-not-exist", isCommand: true }));

    const session = stores.sessions.findByChat("chat-1");
    expect(session?.profileId).toBe("openai-codex:default");
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Unknown profile does-not-exist"),
      expect.any(Object),
    );
  });

  it("handles /health", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const router = new TelegramCommandRouter(
      api as any,
      stores.config,
      new RouteResolver(stores.config, stores.sessions),
      stores.sessions,
      stores.transcripts,
      stores.authProfiles,
      { resolve: vi.fn() } as any,
      { stop: vi.fn(async () => false) } as any,
      stores.health,
    );

    await router.maybeHandle(createInboundEvent({ text: "/health", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Status: ok"),
      expect.any(Object),
    );
  });
});
