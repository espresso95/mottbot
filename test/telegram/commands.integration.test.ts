import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramCommandRouter } from "../../src/telegram/commands.js";
import { RouteResolver } from "../../src/telegram/route-resolver.js";
import { fetchCodexUsage } from "../../src/codex/usage.js";
import { createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { createRuntimeToolRegistry } from "../../src/tools/registry.js";
import { MemoryStore } from "../../src/sessions/memory-store.js";
import { OperatorDiagnostics } from "../../src/app/diagnostics.js";

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

  it("rejects unsafe command input before updating session settings", async () => {
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

    await router.maybeHandle(createInboundEvent({ text: "/model openai-codex/not-a-model", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/profile bad!", isCommand: true }));
    await router.maybeHandle(
      createInboundEvent({ text: `/bind ${"x".repeat(65)}`, isCommand: true }),
    );

    const session = stores.sessions.findByChat("chat-1");
    expect(session?.modelRef).toBe("openai-codex/gpt-5.4");
    expect(session?.profileId).toBe("openai-codex:default");
    expect(session?.routeMode).toBe("dm");
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Unknown model openai-codex/not-a-model"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Invalid profile ID"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Invalid binding name"),
      expect.any(Object),
    );
  });

  it("blocks commands from disallowed chats and non-admin group users", async () => {
    const stores = createStores({
      telegram: {
        allowedChatIds: ["allowed-chat"],
      } as any,
    });
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

    await router.maybeHandle(createInboundEvent({ text: "/auth import-cli", isCommand: true }));
    await router.maybeHandle(
      createInboundEvent({
        chatId: "allowed-chat",
        chatType: "group",
        text: "/auth import-cli",
        isCommand: true,
      }),
    );

    expect(stores.sessions.findByChat("chat-1")).toBeUndefined();
    expect(stores.sessions.findByChat("allowed-chat")).toBeUndefined();
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "This chat is not allowed to use this bot.",
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "allowed-chat",
      "Only configured admins can run bot commands in groups.",
      expect.any(Object),
    );
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
    vi.mocked(fetchCodexUsage).mockResolvedValueOnce({
      provider: "openai-codex",
      displayName: "OpenAI Codex",
      plan: "pro",
      windows: [{ label: "3h", usedPercent: 20, resetAt: 1_700_000_000_000 }],
    });
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
      expect.stringContaining("Usage: Plan: pro; 3h: 20%, resets 2023-11-14T22:13:20.000Z"),
      expect.any(Object),
    );
  });

  it("handles /status when usage is unavailable", async () => {
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
    vi.mocked(fetchCodexUsage).mockRejectedValueOnce(new Error("usage failed"));
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
      expect.stringContaining("Usage: Usage unavailable"),
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

  it("handles admin diagnostics commands", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:admin-1",
      chatId: "chat-1",
      userId: "admin-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const diagnostics = new OperatorDiagnostics(stores.config, stores.database, stores.clock);
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
      undefined,
      undefined,
      undefined,
      diagnostics,
    );

    await router.maybeHandle(createInboundEvent({ text: "/runs here", fromUserId: "admin-1", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/debug config", fromUserId: "admin-1", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/debug service", fromUserId: "user-1", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Recent runs:"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Runtime config:"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Only configured admins can inspect diagnostics.",
      expect.any(Object),
    );
  });

  it("handles memory commands for the current session", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const memories = new MemoryStore(stores.database, stores.clock);
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
      undefined,
      undefined,
      memories,
    );

    await router.maybeHandle(createInboundEvent({ text: "/remember use pnpm", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/memory", isCommand: true }));
    const memory = memories.list("tg:dm:chat-1:user:user-1")[0];
    await router.maybeHandle(createInboundEvent({ text: `/forget ${memory?.id.slice(0, 8)}`, isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Remembered"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("use pnpm"),
      expect.any(Object),
    );
    expect(memories.list("tg:dm:chat-1:user:user-1")).toEqual([]);
  });

  it("requires admin approval for side-effecting tools", async () => {
    const stores = createStores({
      tools: {
        enableSideEffectTools: true,
        approvalTtlMs: 60_000,
        restartDelayMs: 60_000,
      },
    });
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const approvals = new ToolApprovalStore(stores.database, stores.clock);
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
      createRuntimeToolRegistry({ enableSideEffectTools: true }),
      approvals,
    );

    await router.maybeHandle(
      createInboundEvent({
        text: "/tool approve mottbot_restart_service planned restart",
        fromUserId: "user-1",
        isCommand: true,
      }),
    );
    await router.maybeHandle(
      createInboundEvent({
        text: "/tool approve mottbot_restart_service planned restart",
        fromUserId: "admin-1",
        isCommand: true,
      }),
    );
    await router.maybeHandle(createInboundEvent({ text: "/tool status", fromUserId: "admin-1", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/tool status", fromUserId: "user-1", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Only configured admins can approve side-effecting tools.",
      expect.any(Object),
    );
    expect(approvals.listActive("tg:dm:chat-1:user:admin-1")).toHaveLength(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("mottbot_restart_service"),
      expect.any(Object),
    );
    const statusReplies = vi
      .mocked(api.sendMessage)
      .mock.calls.map(([, text]) => text)
      .filter((text): text is string => typeof text === "string" && text.includes("Model-exposed tools"));
    const modelExposedSection = (text: string) => text.split("\n\nEnabled tools:")[0] ?? text;
    const adminExposed = modelExposedSection(statusReplies[0] ?? "");
    const nonAdminExposed = modelExposedSection(statusReplies[1] ?? "");
    expect(adminExposed).toContain("mottbot_recent_runs");
    expect(adminExposed).toContain("mottbot_restart_service");
    expect(statusReplies[0]).toContain("Active approvals");
    expect(nonAdminExposed).toContain("mottbot_health_snapshot");
    expect(nonAdminExposed).not.toContain("mottbot_recent_runs");
    expect(nonAdminExposed).not.toContain("mottbot_restart_service");
  });
});
