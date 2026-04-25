import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramCommandRouter } from "../../src/telegram/commands.js";
import { RouteResolver } from "../../src/telegram/route-resolver.js";
import { fetchCodexUsage } from "../../src/codex/usage.js";
import { createCallbackEvent, createInboundEvent, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { createRuntimeToolRegistry } from "../../src/tools/registry.js";
import { MemoryStore } from "../../src/sessions/memory-store.js";
import { OperatorDiagnostics } from "../../src/app/diagnostics.js";
import type { GithubReadOperations } from "../../src/tools/github-read.js";
import { TelegramGovernanceStore } from "../../src/telegram/governance.js";
import { UsageBudgetService } from "../../src/runs/usage-budget.js";
import {
  buildMemoryCandidateAcceptCallbackData,
  buildProjectApprovalCallbackData,
  buildToolApprovalCallbackData,
  buildToolDenyCallbackData,
} from "../../src/telegram/callback-data.js";

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
    await router.maybeHandle(createInboundEvent({ text: `/bind ${"x".repeat(65)}`, isCommand: true }));

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
    await router.maybeHandle(
      createInboundEvent({
        chatId: "allowed-chat",
        chatType: "group",
        text: "/help",
        fromUserId: "user-1",
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
      "Only owner/admin roles can run bot commands in groups unless a chat policy allows the command.",
      expect.any(Object),
    );
  });

  it("ignores commands addressed to a different Telegram bot", async () => {
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
      createInboundEvent({
        text: "/help@OtherBot",
        commandTargetUsername: "OtherBot",
        isCommand: false,
      }),
    );

    expect(handled).toBe(true);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("limits Project Mode commands to owner/admin callers", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const projects = { handle: vi.fn(async () => undefined) };
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      projects as any,
    );

    await router.maybeHandle(createInboundEvent({ text: "/project status", fromUserId: "user-1", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/project status", fromUserId: "admin-1", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Only owner/admin roles can use Project Mode.",
      expect.any(Object),
    );
    expect(projects.handle).toHaveBeenCalledTimes(1);
    expect(projects.handle).toHaveBeenCalledWith(expect.objectContaining({ fromUserId: "admin-1" }), ["status"]);
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
      {
        resolve: vi.fn(async () => ({
          accessToken: "access",
          apiKey: "access",
          profile: stores.authProfiles.get("openai-codex:default")!,
        })),
      } as any,
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
      {
        resolve: vi.fn(async () => ({
          accessToken: "access",
          apiKey: "access",
          profile: stores.authProfiles.get("openai-codex:default")!,
        })),
      } as any,
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

  it("handles admin GitHub status commands without model tool use", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const github: GithubReadOperations = {
      repository: vi.fn(async () => ({
        repository: "espresso95/mottbot",
        url: "https://github.com/espresso95/mottbot",
        description: "",
        defaultBranch: "main",
        isPrivate: false,
        isArchived: false,
        isFork: false,
      })),
      openPullRequests: vi.fn(async () => ({
        repository: "espresso95/mottbot",
        pullRequests: [
          { number: 3, title: "Add feature", url: "https://github.com/espresso95/mottbot/pull/3", isDraft: false },
        ],
        truncated: false,
      })),
      recentIssues: vi.fn(async () => ({ repository: "espresso95/mottbot", issues: [], truncated: false })),
      ciStatus: vi.fn(async () => ({
        repository: "espresso95/mottbot",
        runs: [
          {
            databaseId: 10,
            workflowName: "ci",
            displayTitle: "Build",
            status: "completed",
            conclusion: "failure",
            url: "https://github.com/espresso95/mottbot/actions/runs/10",
          },
        ],
        truncated: false,
      })),
      recentWorkflowFailures: vi.fn(async () => ({ repository: "espresso95/mottbot", runs: [], truncated: false })),
    };
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
      undefined,
      undefined,
      undefined,
      github,
    );

    const handled = await router.maybeHandle(
      createInboundEvent({ text: "/github status 2 espresso95/mottbot", fromUserId: "admin-1", isCommand: true }),
    );

    expect(handled).toBe(true);
    expect(github.repository).toHaveBeenCalledWith({ repository: "espresso95/mottbot" });
    expect(github.openPullRequests).toHaveBeenCalledWith({ repository: "espresso95/mottbot", limit: 2 });
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Latest CI: ci completed/failure"),
      expect.any(Object),
    );
  });

  it("handles GitHub command subcommands and errors", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const github: GithubReadOperations = {
      repository: vi.fn(async () => ({
        repository: "espresso95/mottbot",
        url: "https://github.com/espresso95/mottbot",
        description: "test repo",
        defaultBranch: "main",
        isPrivate: false,
        isArchived: false,
        isFork: false,
      })),
      openPullRequests: vi.fn(async () => ({
        repository: "espresso95/mottbot",
        pullRequests: [
          { number: 3, title: "Add feature", url: "https://github.com/espresso95/mottbot/pull/3", isDraft: false },
        ],
        truncated: false,
      })),
      recentIssues: vi.fn(async () => ({
        repository: "espresso95/mottbot",
        issues: [
          { number: 5, title: "Fix issue", url: "https://github.com/espresso95/mottbot/issues/5", labels: ["bug"] },
        ],
        truncated: false,
      })),
      ciStatus: vi.fn(async () => ({
        repository: "espresso95/mottbot",
        runs: [
          {
            databaseId: 10,
            workflowName: "ci",
            displayTitle: "Build",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/espresso95/mottbot/actions/runs/10",
          },
        ],
        truncated: false,
      })),
      recentWorkflowFailures: vi.fn(async () => ({ repository: "espresso95/mottbot", runs: [], truncated: false })),
    };
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
      undefined,
      undefined,
      undefined,
      github,
    );

    for (const text of [
      "/github help",
      "/github repo",
      "/github prs 1",
      "/github issues",
      "/github runs",
      "/github failures",
      "/github unknown",
    ]) {
      await router.maybeHandle(createInboundEvent({ text, fromUserId: "admin-1", isCommand: true }));
    }

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("GitHub commands"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("GitHub repository"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Open pull requests"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("Open issues"), expect.any(Object));
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Recent workflow runs"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Recent failed workflow runs"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("Latest CI"), expect.any(Object));
  });

  it("reports unavailable GitHub integration and GitHub read errors", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const unavailableRouter = new TelegramCommandRouter(
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
    await unavailableRouter.maybeHandle(
      createInboundEvent({ text: "/github status", fromUserId: "admin-1", isCommand: true }),
    );

    const errorRouter = new TelegramCommandRouter(
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
      undefined,
      undefined,
      undefined,
      {
        repository: vi.fn(async () => {
          throw new Error("gh auth failed");
        }),
        openPullRequests: vi.fn(),
        recentIssues: vi.fn(),
        ciStatus: vi.fn(),
        recentWorkflowFailures: vi.fn(),
      } as unknown as GithubReadOperations,
    );
    await errorRouter.maybeHandle(createInboundEvent({ text: "/github repo", fromUserId: "admin-1", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", "GitHub integration is not available.", expect.any(Object));
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", "gh auth failed", expect.any(Object));
  });

  it("denies GitHub commands for non-admin callers", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const github = {
      repository: vi.fn(),
    } as unknown as GithubReadOperations;
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
      undefined,
      undefined,
      undefined,
      github,
    );

    await router.maybeHandle(createInboundEvent({ text: "/github status", isCommand: true }));

    expect(github.repository).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Only owner/admin roles can inspect GitHub.",
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

  it("lists and switches configured agents with policy checks", async () => {
    const stores = createStores({
      agents: {
        defaultId: "main",
        list: [
          {
            id: "main",
            profileId: "openai-codex:default",
            modelRef: "openai-codex/gpt-5.4",
            fastMode: false,
          },
          {
            id: "docs",
            displayName: "Docs",
            profileId: "openai-codex:docs",
            modelRef: "openai-codex/gpt-5.4-mini",
            fastMode: true,
            systemPrompt: "Write concise docs.",
            toolNames: ["mottbot_health_snapshot"],
          },
        ],
        bindings: [],
      },
    });
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
    stores.authProfiles.upsert({
      profileId: "openai-codex:docs",
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

    await router.maybeHandle(createInboundEvent({ text: "/agent list", fromUserId: "admin-1", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/agent set docs", fromUserId: "admin-1", isCommand: true }));

    const session = stores.sessions.get("tg:dm:chat-1:user:admin-1");
    expect(session).toMatchObject({
      agentId: "docs",
      profileId: "openai-codex:docs",
      modelRef: "openai-codex/gpt-5.4-mini",
      fastMode: true,
      systemPrompt: "Write concise docs.",
    });
    const replies = vi.mocked(api.sendMessage).mock.calls.map(([, text]) => String(text));
    expect(replies[0]).toContain("docs (Docs)");
    expect(replies[1]).toContain("Agent set to docs");
  });

  it("rejects agent switching when chat governance disallows the agent model", async () => {
    const stores = createStores({
      agents: {
        defaultId: "main",
        list: [
          {
            id: "main",
            profileId: "openai-codex:default",
            modelRef: "openai-codex/gpt-5.4",
            fastMode: false,
          },
          {
            id: "docs",
            profileId: "openai-codex:default",
            modelRef: "openai-codex/gpt-5.4-mini",
            fastMode: false,
          },
        ],
        bindings: [],
      },
    });
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
    const governance = new TelegramGovernanceStore(stores.database, stores.clock, {
      ownerUserIds: stores.config.telegram.adminUserIds,
    });
    governance.setChatPolicy({
      chatId: "chat-1",
      actorUserId: "admin-1",
      policy: { modelRefs: ["openai-codex/gpt-5.4"] },
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      governance,
    );

    await router.maybeHandle(createInboundEvent({ text: "/agent set docs", fromUserId: "admin-1", isCommand: true }));

    expect(stores.sessions.findByChat("chat-1")?.agentId).toBe("main");
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("not allowed in this chat"),
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

    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("Status: ok"), expect.any(Object));
  });

  it("handles /usage with local budget reporting", async () => {
    const stores = createStores({
      usage: {
        dailyRuns: 10,
      },
    });
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    stores.runs.update(run.runId, { status: "completed", finishedAt: stores.clock.now() });
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      new UsageBudgetService(stores.config, stores.runs, stores.clock),
    );

    await router.maybeHandle(createInboundEvent({ text: "/usage monthly", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/usage yearly", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Monthly usage since"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("No monthly limits configured."),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", "Usage: /usage [daily|monthly]", expect.any(Object));
  });

  it("handles caller-aware help for admins and non-admin users", async () => {
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
    const memories = new MemoryStore(stores.database, stores.clock);
    const approvals = new ToolApprovalStore(stores.database, stores.clock);
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
      createRuntimeToolRegistry({ enableSideEffectTools: true }),
      approvals,
      memories,
      diagnostics,
    );

    await router.maybeHandle(
      createInboundEvent({ text: "/help@StartupMottBot", fromUserId: "admin-1", isCommand: true }),
    );
    await router.maybeHandle(createInboundEvent({ text: "/help", fromUserId: "user-1", isCommand: true }));

    const replies = vi.mocked(api.sendMessage).mock.calls.map(([, text]) => String(text));
    const adminHelp = replies[0] ?? "";
    const nonAdminHelp = replies[1] ?? "";
    const nonAdminToolSection = nonAdminHelp.split("Model-exposed tools for this caller:")[1] ?? "";

    expect(adminHelp).toContain("Admin diagnostics");
    expect(adminHelp).toContain("/debug summary|service|runs|agents|errors|logs|config");
    expect(adminHelp).toContain("/tool approve <tool-name> <reason>");
    expect(adminHelp).toContain("mottbot_recent_runs");
    expect(adminHelp).toContain("mottbot_restart_service");
    expect(adminHelp).toContain("/remember <fact>");

    expect(nonAdminHelp).toContain("Mottbot help");
    expect(nonAdminHelp).toContain("/commands - same as /help");
    expect(nonAdminHelp).toContain("/status");
    expect(nonAdminHelp).not.toContain("Admin diagnostics");
    expect(nonAdminHelp).not.toContain("/tool approve <tool-name> <reason>");
    expect(nonAdminToolSection).toContain("mottbot_health_snapshot");
    expect(nonAdminToolSection).not.toContain("mottbot_recent_runs");
    expect(nonAdminToolSection).not.toContain("mottbot_restart_service");
  });

  it("manages governance roles and enforces chat command and model policy", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = { sendMessage: vi.fn(async () => ({})) };
    const governance = new TelegramGovernanceStore(stores.database, stores.clock, {
      ownerUserIds: stores.config.telegram.adminUserIds,
    });
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
      undefined,
      undefined,
      undefined,
      undefined,
      governance,
    );

    await router.maybeHandle(createInboundEvent({ text: "/users me", fromUserId: "user-1", isCommand: true }));
    await router.maybeHandle(
      createInboundEvent({ text: "/users grant user-2 trusted onboarding", fromUserId: "admin-1", isCommand: true }),
    );
    await router.maybeHandle(createInboundEvent({ text: "/users list", fromUserId: "admin-1", isCommand: true }));
    await router.maybeHandle(
      createInboundEvent({
        text: '/users chat set group-1 {"allowedRoles":["trusted"],"commandRoles":{"help":["trusted"]},"modelRefs":["openai-codex/gpt-5.4-mini"],"memoryScopes":["session"],"attachmentMaxPerMessage":1}',
        fromUserId: "admin-1",
        isCommand: true,
      }),
    );
    await router.maybeHandle(
      createInboundEvent({
        chatId: "group-1",
        chatType: "group",
        text: "/help",
        fromUserId: "user-2",
        isCommand: true,
      }),
    );
    await router.maybeHandle(
      createInboundEvent({
        chatId: "group-1",
        chatType: "group",
        text: "/help",
        fromUserId: "user-1",
        isCommand: true,
      }),
    );
    await router.maybeHandle(
      createInboundEvent({
        chatId: "group-1",
        chatType: "group",
        text: "/model openai-codex/gpt-5.4",
        fromUserId: "admin-1",
        isCommand: true,
      }),
    );
    await router.maybeHandle(
      createInboundEvent({
        chatId: "group-1",
        chatType: "group",
        text: "/model openai-codex/gpt-5.4-mini",
        fromUserId: "admin-1",
        isCommand: true,
      }),
    );
    await router.maybeHandle(createInboundEvent({ text: "/users audit", fromUserId: "admin-1", isCommand: true }));
    await router.maybeHandle(
      createInboundEvent({ text: "/users revoke user-2 cleanup", fromUserId: "admin-1", isCommand: true }),
    );

    const replies = vi.mocked(api.sendMessage).mock.calls.map(([, text]) => String(text));
    const trustedGroupHelp = replies.find((reply) => reply.includes("Mottbot help")) ?? "";
    expect(replies).toContain("Your role: user");
    expect(replies).toContain("Granted trusted to user-2.");
    expect(replies.some((reply) => reply.includes("user-2: trusted"))).toBe(true);
    expect(trustedGroupHelp).toContain("/help - show commands available to this caller");
    expect(trustedGroupHelp).not.toContain("/status");
    expect(trustedGroupHelp).not.toContain("/model <provider/model>");
    expect(trustedGroupHelp).not.toContain("/users me");
    expect(replies).toContain("Your role is not allowed to use this chat.");
    expect(replies).toContain("Model openai-codex/gpt-5.4 is not allowed in this chat.");
    expect(replies).toContain("Model set to openai-codex/gpt-5.4-mini.");
    expect(replies.some((reply) => reply.includes("grant_role"))).toBe(true);
    expect(replies).toContain("Revoked role for user-2.");
  });

  it("shows tool help through /tool help and /tools", async () => {
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
      new ToolApprovalStore(stores.database, stores.clock),
    );

    await router.maybeHandle(createInboundEvent({ text: "/tool help", fromUserId: "admin-1", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/tools", fromUserId: "user-1", isCommand: true }));

    const replies = vi.mocked(api.sendMessage).mock.calls.map(([, text]) => String(text));
    expect(replies[0]).toContain("Tool help");
    expect(replies[0]).toContain("/tool approve <tool-name> <reason>");
    expect(replies[0]).toContain("mottbot_restart_service");
    expect(replies[1]).toContain("Tool help");
    expect(replies[1]).toContain("Approvals are admin-only.");
    expect(replies[1]).not.toContain("mottbot_restart_service");
  });

  it("filters tool help by governed group command policy", async () => {
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
    const governance = new TelegramGovernanceStore(stores.database, stores.clock, {
      ownerUserIds: stores.config.telegram.adminUserIds,
    });
    governance.setUserRole({ userId: "user-2", role: "trusted", actorUserId: "admin-1" });
    governance.setChatPolicy({
      chatId: "group-1",
      actorUserId: "admin-1",
      policy: { commandRoles: { tools: ["trusted"] } },
    });
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
      new ToolApprovalStore(stores.database, stores.clock),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      governance,
    );

    await router.maybeHandle(
      createInboundEvent({
        chatId: "group-1",
        chatType: "group",
        text: "/tools",
        fromUserId: "user-2",
        isCommand: true,
      }),
    );
    await router.maybeHandle(
      createInboundEvent({
        chatId: "group-1",
        chatType: "group",
        text: "/tools status",
        fromUserId: "user-2",
        isCommand: true,
      }),
    );

    const reply = String(vi.mocked(api.sendMessage).mock.calls[0]?.[1] ?? "");
    const statusAliasReply = String(vi.mocked(api.sendMessage).mock.calls[1]?.[1] ?? "");
    expect(reply).toContain("Tool help");
    expect(reply).toContain("/tools - show this help");
    expect(reply).not.toContain("/tool status");
    expect(reply).not.toContain("/tool help");
    expect(reply).toContain("Approvals are admin-only.");
    expect(statusAliasReply).toContain("Tool help");
    expect(statusAliasReply).not.toContain("Enabled tools:");
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
    await router.maybeHandle(createInboundEvent({ text: "/debug agents", fromUserId: "admin-1", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/debug service", fromUserId: "user-1", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("Recent runs:"), expect.any(Object));
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Runtime config:"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Agent diagnostics:"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Only owner/admin roles can inspect diagnostics.",
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

    await router.maybeHandle(createInboundEvent({ text: "/remember scope:personal use pnpm", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/memory", isCommand: true }));
    const memory = memories.listForScopeContext({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
    })[0];
    await router.maybeHandle(createInboundEvent({ text: `/forget ${memory?.id.slice(0, 8)}`, isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("Remembered"), expect.any(Object));
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("use pnpm"), expect.any(Object));
    expect(
      memories.listForScopeContext({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
      }),
    ).toEqual([]);
  });

  it("handles memory candidate review commands", async () => {
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
    const session = new RouteResolver(stores.config, stores.sessions).resolve(createInboundEvent());
    const candidate = memories.addCandidate({
      sessionKey: session.sessionKey,
      scope: "personal",
      scopeKey: "user-1",
      contentText: "User likes short answers.",
      reason: "Preference stated by user.",
      sourceMessageIds: ["msg-1"],
      sensitivity: "low",
    });
    if (!candidate.inserted) {
      throw new Error("expected inserted candidate");
    }

    await router.maybeHandle(createInboundEvent({ text: "/memory candidates", isCommand: true }));
    await router.maybeHandle(
      createInboundEvent({
        text: `/memory edit ${candidate.candidate.id.slice(0, 8)} User likes direct answers.`,
        isCommand: true,
      }),
    );
    await router.maybeHandle(
      createInboundEvent({ text: `/memory accept ${candidate.candidate.id.slice(0, 8)}`, isCommand: true }),
    );
    const accepted = memories.listForScopeContext(session)[0];
    await router.maybeHandle(createInboundEvent({ text: `/memory pin ${accepted?.id.slice(0, 8)}`, isCommand: true }));
    await router.maybeHandle(
      createInboundEvent({ text: `/memory archive ${accepted?.id.slice(0, 8)}`, isCommand: true }),
    );
    const rejectable = memories.addCandidate({
      sessionKey: session.sessionKey,
      scope: "session",
      scopeKey: session.sessionKey,
      contentText: "Reject me.",
      sensitivity: "low",
    });
    if (!rejectable.inserted) {
      throw new Error("expected rejectable candidate");
    }
    await router.maybeHandle(
      createInboundEvent({ text: `/memory reject ${rejectable.candidate.id.slice(0, 8)}`, isCommand: true }),
    );
    memories.addCandidate({
      sessionKey: session.sessionKey,
      scope: "session",
      scopeKey: session.sessionKey,
      contentText: "Clear me.",
      sensitivity: "low",
    });
    await router.maybeHandle(createInboundEvent({ text: "/memory clear candidates", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("User likes short answers."),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("Candidate"), expect.any(Object));
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("Accepted"), expect.any(Object));
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", "Candidate rejected.", expect.any(Object));
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Cleared 1 pending memory candidates."),
      expect.any(Object),
    );
    expect(memories.listForScopeContext(session)).toEqual([]);
  });

  it("reviews memory candidates from callback buttons", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      answerCallbackQuery: vi.fn(async () => ({})),
      editMessageReplyMarkup: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({})),
    };
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
    const session = new RouteResolver(stores.config, stores.sessions).resolve(createInboundEvent());
    const candidate = memories.addCandidate({
      sessionKey: session.sessionKey,
      scope: "personal",
      scopeKey: "user-1",
      contentText: "User prefers button-driven review.",
      reason: "Preference stated by user.",
      sourceMessageIds: ["msg-1"],
      sensitivity: "low",
    });
    if (!candidate.inserted) {
      throw new Error("expected inserted candidate");
    }

    await router.maybeHandle(createInboundEvent({ text: "/memory candidates", isCommand: true }));
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("User prefers button-driven review."),
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `Accept ${candidate.candidate.id.slice(0, 8)}`,
                callback_data: buildMemoryCandidateAcceptCallbackData(candidate.candidate.id),
              },
              {
                text: "Reject",
                callback_data: expect.stringMatching(/^mb:mr:/),
              },
              {
                text: "Archive",
                callback_data: expect.stringMatching(/^mb:mh:/),
              },
            ],
          ],
        },
      }),
    );

    const handled = await router.maybeHandleCallback(
      createCallbackEvent({
        data: buildMemoryCandidateAcceptCallbackData(candidate.candidate.id),
      }),
    );

    expect(handled).toBe(true);
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: expect.stringContaining("Accepted"),
      show_alert: false,
    });
    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith("chat-1", 42, {});
    expect(api.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("Accepted"), expect.any(Object));
    expect(memories.listForScopeContext(session)).toEqual([
      expect.objectContaining({
        contentText: "User prefers button-driven review.",
        scope: "personal",
      }),
    ]);
  });

  it("lists and forgets file metadata without clearing unrelated transcript text", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    stores.transcripts.add({
      sessionKey: session.sessionKey,
      runId: run.runId,
      role: "user",
      contentText: "please read this",
      contentJson: JSON.stringify({
        attachments: [
          {
            recordId: "file-record-1",
            kind: "document",
            fileId: "telegram-file",
            fileName: "notes.md",
            ingestionStatus: "extracted_text",
          },
        ],
      }),
    });
    stores.attachmentRecords.addMany({
      sessionKey: session.sessionKey,
      runId: run.runId,
      telegramMessageId: 42,
      attachments: [
        {
          recordId: "file-record-1",
          kind: "document",
          fileId: "telegram-file",
          fileName: "notes.md",
          ingestionStatus: "extracted_text",
          extraction: {
            kind: "markdown",
            status: "extracted",
            promptChars: 20,
          },
        },
      ],
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
      undefined,
      undefined,
      undefined,
      undefined,
      stores.attachmentRecords,
    );

    await router.maybeHandle(createInboundEvent({ text: "/files", isCommand: true }));
    await router.maybeHandle(createInboundEvent({ text: "/files forget file-rec", isCommand: true }));

    const replies = vi.mocked(api.sendMessage).mock.calls.map(([, text]) => String(text));
    expect(replies[0]).toContain("notes.md");
    expect(replies[0]).toContain("extracted_text");
    expect(replies[1]).toContain("Forgot file");
    expect(stores.attachmentRecords.listRecent(session.sessionKey)).toEqual([]);
    const transcript = stores.transcripts.listRecent(session.sessionKey)[0];
    expect(transcript?.contentText).toBe("please read this");
    expect(transcript?.contentJson).toBeUndefined();
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
    await router.maybeHandle(
      createInboundEvent({ text: "/tool audit here code:operator_approved", fromUserId: "admin-1", isCommand: true }),
    );
    await router.maybeHandle(createInboundEvent({ text: "/tool audit", fromUserId: "user-1", isCommand: true }));

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Only owner/admin roles can approve side-effecting tools.",
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
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("operator_approved"),
      expect.any(Object),
    );
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Only owner/admin roles can inspect tool audit records.",
      expect.any(Object),
    );
  });

  it("does not approve stale pending requests from the typed tool approve fallback", async () => {
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
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:admin-1",
      chatId: "chat-1",
      userId: "admin-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    approvals.recordAudit({
      sessionKey: session.sessionKey,
      toolName: "mottbot_restart_service",
      sideEffect: "process_control",
      allowed: false,
      decisionCode: "approval_required",
      requestedAt: stores.clock.now() - 60_001,
      decidedAt: stores.clock.now() - 60_001,
      requestFingerprint: "request-fingerprint",
      previewText: "Approval preview text",
    });
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
        fromUserId: "admin-1",
        isCommand: true,
      }),
    );

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Latest pending request for mottbot_restart_service expired. Ask the model to retry.",
      expect.any(Object),
    );
    expect(approvals.listActive(session.sessionKey)).toEqual([]);
    expect(approvals.listAudit({ sessionKey: session.sessionKey, decisionCode: "approval_expired" })).toEqual([
      expect.objectContaining({
        toolName: "mottbot_restart_service",
        requestFingerprint: "request-fingerprint",
      }),
    ]);
  });

  it("approves pending side-effecting tool requests from callback buttons", async () => {
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
    const api = {
      answerCallbackQuery: vi.fn(async () => ({})),
      editMessageText: vi.fn(async () => ({})),
      editMessageReplyMarkup: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({})),
    };
    const orchestrator = {
      stop: vi.fn(async () => false),
      enqueueMessage: vi.fn(async () => undefined),
    };
    const approvals = new ToolApprovalStore(stores.database, stores.clock);
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:admin-1",
      chatId: "chat-1",
      userId: "admin-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    const pending = approvals.recordAudit({
      sessionKey: session.sessionKey,
      runId: run.runId,
      toolName: "mottbot_restart_service",
      sideEffect: "process_control",
      allowed: false,
      decisionCode: "approval_required",
      requestedAt: stores.clock.now(),
      decidedAt: stores.clock.now(),
      requestFingerprint: "request-fingerprint",
      previewText: "Approval preview text",
    });
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
      createRuntimeToolRegistry({ enableSideEffectTools: true }),
      approvals,
    );

    const handled = await router.maybeHandleCallback(
      createCallbackEvent({
        fromUserId: "admin-1",
        data: buildToolApprovalCallbackData(pending.id!),
        messageText: "Approval required.",
      }),
    );

    expect(handled).toBe(true);
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: "Approved mottbot_restart_service. Continuing.",
      show_alert: false,
    });
    expect(api.editMessageText).toHaveBeenCalledWith(
      "chat-1",
      42,
      "Approval required.\n\nApproved mottbot_restart_service. Continuing...",
    );
    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith("chat-1", 42);
    expect(orchestrator.enqueueMessage).toHaveBeenCalledWith({
      event: expect.objectContaining({
        chatId: "chat-1",
        messageId: 42,
        fromUserId: "admin-1",
        text: expect.stringContaining("Continue the previous user request now."),
      }),
      session: expect.objectContaining({
        sessionKey: "tg:dm:chat-1:user:admin-1",
      }),
    });
    expect(orchestrator.enqueueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          text: expect.stringContaining("Approval preview text"),
        }),
      }),
    );
    expect(api.sendMessage).not.toHaveBeenCalledWith(
      "chat-1",
      expect.stringContaining("Approved mottbot_restart_service"),
      expect.any(Object),
    );
    expect(approvals.listActive("tg:dm:chat-1:user:admin-1")).toEqual([
      expect.objectContaining({
        toolName: "mottbot_restart_service",
        approvedByUserId: "admin-1",
        requestFingerprint: "request-fingerprint",
        previewText: "Approval preview text",
      }),
    ]);

    api.answerCallbackQuery.mockClear();
    api.editMessageText.mockClear();
    api.editMessageReplyMarkup.mockClear();
    api.sendMessage.mockClear();
    orchestrator.enqueueMessage.mockClear();

    await expect(
      router.maybeHandleCallback(
        createCallbackEvent({
          fromUserId: "admin-1",
          data: buildToolApprovalCallbackData(pending.id!),
        }),
      ),
    ).resolves.toBe(true);

    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: "This request was already approved.",
      show_alert: false,
    });
    expect(api.editMessageText).toHaveBeenCalledWith("chat-1", 42, "This request was already approved.");
    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith("chat-1", 42);
    expect(orchestrator.enqueueMessage).not.toHaveBeenCalled();
    expect(approvals.listAudit({ sessionKey: session.sessionKey, decisionCode: "operator_approved" })).toHaveLength(1);
  });

  it("denies pending side-effecting tool requests from callback buttons", async () => {
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
    const api = {
      answerCallbackQuery: vi.fn(async () => ({})),
      editMessageText: vi.fn(async () => ({})),
      editMessageReplyMarkup: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({})),
    };
    const orchestrator = {
      stop: vi.fn(async () => false),
      enqueueMessage: vi.fn(async () => undefined),
    };
    const approvals = new ToolApprovalStore(stores.database, stores.clock);
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:admin-1",
      chatId: "chat-1",
      userId: "admin-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = stores.runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    const pending = approvals.recordAudit({
      sessionKey: session.sessionKey,
      runId: run.runId,
      toolName: "mottbot_restart_service",
      sideEffect: "process_control",
      allowed: false,
      decisionCode: "approval_required",
      requestedAt: stores.clock.now(),
      decidedAt: stores.clock.now(),
      requestFingerprint: "request-fingerprint",
      previewText: "Approval preview text",
    });
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
      createRuntimeToolRegistry({ enableSideEffectTools: true }),
      approvals,
    );

    const handled = await router.maybeHandleCallback(
      createCallbackEvent({
        fromUserId: "admin-1",
        data: buildToolDenyCallbackData(pending.id!),
        messageText: "Approval required.",
      }),
    );

    expect(handled).toBe(true);
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: "Denied mottbot_restart_service.",
      show_alert: false,
    });
    expect(api.editMessageText).toHaveBeenCalledWith(
      "chat-1",
      42,
      "Approval required.\n\nDenied mottbot_restart_service.",
    );
    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith("chat-1", 42);
    expect(orchestrator.enqueueMessage).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Denied mottbot_restart_service. The pending request will not continue.",
      expect.any(Object),
    );
    expect(approvals.listActive("tg:dm:chat-1:user:admin-1")).toEqual([]);
    expect(approvals.listAudit({ sessionKey: session.sessionKey, decisionCode: "operator_denied" })).toEqual([
      expect.objectContaining({
        toolName: "mottbot_restart_service",
        requestFingerprint: "request-fingerprint",
        previewText: "Approval preview text",
        approvedByUserId: "admin-1",
      }),
    ]);
  });

  it("expires stale pending tool callback buttons without approving or continuing", async () => {
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
    const api = {
      answerCallbackQuery: vi.fn(async () => ({})),
      editMessageText: vi.fn(async () => ({})),
      editMessageReplyMarkup: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({})),
    };
    const orchestrator = {
      stop: vi.fn(async () => false),
      enqueueMessage: vi.fn(async () => undefined),
    };
    const approvals = new ToolApprovalStore(stores.database, stores.clock);
    const session = stores.sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:admin-1",
      chatId: "chat-1",
      userId: "admin-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const pending = approvals.recordAudit({
      sessionKey: session.sessionKey,
      toolName: "mottbot_restart_service",
      sideEffect: "process_control",
      allowed: false,
      decisionCode: "approval_required",
      requestedAt: stores.clock.now() - 60_001,
      decidedAt: stores.clock.now() - 60_001,
      requestFingerprint: "request-fingerprint",
      previewText: "Approval preview text",
    });
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
      createRuntimeToolRegistry({ enableSideEffectTools: true }),
      approvals,
    );

    const handled = await router.maybeHandleCallback(
      createCallbackEvent({
        fromUserId: "admin-1",
        data: buildToolApprovalCallbackData(pending.id!),
        messageText: "Approval required.",
      }),
    );

    const expiredMessage = "Approval request for mottbot_restart_service expired. Ask the model to retry the action.";
    expect(handled).toBe(true);
    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: expiredMessage,
      show_alert: true,
    });
    expect(api.editMessageText).toHaveBeenCalledWith("chat-1", 42, `Approval required.\n\n${expiredMessage}`);
    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith("chat-1", 42);
    expect(orchestrator.enqueueMessage).not.toHaveBeenCalled();
    expect(approvals.listActive(session.sessionKey)).toEqual([]);
    expect(approvals.listAudit({ sessionKey: session.sessionKey, decisionCode: "approval_expired" })).toEqual([
      expect.objectContaining({
        toolName: "mottbot_restart_service",
        requestFingerprint: "request-fingerprint",
        previewText: "Approval preview text",
        approvedByUserId: "admin-1",
      }),
    ]);

    api.answerCallbackQuery.mockClear();
    api.editMessageText.mockClear();
    api.editMessageReplyMarkup.mockClear();
    api.sendMessage.mockClear();

    await expect(
      router.maybeHandleCallback(
        createCallbackEvent({
          fromUserId: "admin-1",
          data: buildToolApprovalCallbackData(pending.id!),
          messageText: "Approval required.",
        }),
      ),
    ).resolves.toBe(true);

    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: "This approval request has already expired.",
      show_alert: false,
    });
    expect(api.editMessageText).toHaveBeenCalledWith(
      "chat-1",
      42,
      "Approval required.\n\nThis approval request has already expired.",
    );
    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith("chat-1", 42);
    expect(approvals.listAudit({ sessionKey: session.sessionKey, decisionCode: "approval_expired" })).toHaveLength(1);
  });

  it("routes project approval callbacks and ignores unknown callback data", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    const api = {
      answerCallbackQuery: vi.fn(async () => ({})),
      sendMessage: vi.fn(async () => ({})),
    };
    const projects = {
      handleApprovalCallback: vi.fn(async () => undefined),
    };
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      projects as any,
    );

    await expect(router.maybeHandleCallback(createCallbackEvent({ data: "not-mottbot-callback" }))).resolves.toBe(
      false,
    );

    const event = createCallbackEvent({
      fromUserId: "admin-1",
      data: buildProjectApprovalCallbackData("approval-1"),
    });
    await expect(router.maybeHandleCallback(event)).resolves.toBe(true);

    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: "Processing project approval.",
      show_alert: false,
    });
    expect(projects.handleApprovalCallback).toHaveBeenCalledWith(event, "approval-1");

    api.answerCallbackQuery.mockClear();
    api.sendMessage.mockClear();
    projects.handleApprovalCallback.mockClear();

    await expect(
      router.maybeHandleCallback(
        createCallbackEvent({
          fromUserId: "user-1",
          data: buildProjectApprovalCallbackData("approval-1"),
        }),
      ),
    ).resolves.toBe(true);

    expect(api.answerCallbackQuery).toHaveBeenCalledWith("callback-1", {
      text: "Only owner/admin roles can use Project Mode.",
      show_alert: true,
    });
    expect(api.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      "Only owner/admin roles can use Project Mode.",
      expect.any(Object),
    );
    expect(projects.handleApprovalCallback).not.toHaveBeenCalled();
  });
});
