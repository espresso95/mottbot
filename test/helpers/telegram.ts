import type { Api } from "grammy";
import { vi } from "vitest";
import type { CodexResolvedAuth } from "../../src/codex/types.js";
import { RouteResolver } from "../../src/telegram/route-resolver.js";
import { TelegramCommandRouter, type TelegramCommandRouterOptions } from "../../src/telegram/commands.js";
import type { createStores } from "./fakes.js";

type TestStores = ReturnType<typeof createStores>;

/** Test double for the Telegram API methods used by runtime services. */
function createTelegramApiMock() {
  return {
    sendMessage: vi.fn(async () => ({ message_id: 100 })),
    editMessageText: vi.fn(async () => undefined),
    editMessageReplyMarkup: vi.fn(async () => undefined),
    answerCallbackQuery: vi.fn(async () => true),
    setMessageReaction: vi.fn(async () => true),
    getFile: vi.fn(async () => ({ file_path: "files/mock" })),
    getMe: vi.fn(async () => ({ username: "mottbot" })),
    deleteWebhook: vi.fn(async () => true),
    setWebhook: vi.fn(async () => true),
    setMyCommands: vi.fn(async () => true),
  };
}

type TelegramApiMock = ReturnType<typeof createTelegramApiMock>;

/** Adapts a structural API test double to grammY's broad Api type at one boundary. */
function asTelegramApi(api: TelegramApiMock): Api {
  return api as unknown as Api;
}

/** Auth payload used by Telegram command tests that need a resolved Codex profile. */
function createResolvedAuth(profileId = "openai-codex:default"): CodexResolvedAuth {
  return {
    profile: {
      profileId,
      provider: "openai-codex",
      source: "local_oauth",
      accessToken: "access",
      createdAt: 1,
      updatedAt: 1,
    },
    accessToken: "access",
    apiKey: "access",
  };
}

/** Token resolver fake with the same public surface used by command handlers. */
function createTokenResolverMock(
  resolve = vi.fn(async (profileId: string) => createResolvedAuth(profileId)),
): TelegramCommandRouterOptions["tokenResolver"] {
  return { resolve };
}

/** Run orchestrator fake covering the command and callback methods used by Telegram routing. */
export function createRunOrchestratorMock(
  overrides: Partial<TelegramCommandRouterOptions["orchestrator"]> = {},
): TelegramCommandRouterOptions["orchestrator"] {
  return {
    continueApprovedTool: vi.fn(async () => false),
    enqueueMessage: vi.fn(async () => undefined),
    retryRun: vi.fn(async () => "not_found"),
    stop: vi.fn(async () => false),
    ...overrides,
  };
}

/** Builds a command router with real stores and typed fake collaborators. */
export function createTelegramCommandRouter(
  stores: TestStores,
  options: Omit<Partial<TelegramCommandRouterOptions>, "api"> & { api?: Partial<TelegramApiMock> } = {},
): TelegramCommandRouter {
  const { api: apiOverrides, ...routerOptions } = options;
  const api = asTelegramApi({ ...createTelegramApiMock(), ...apiOverrides });
  return new TelegramCommandRouter({
    api,
    config: stores.config,
    routes: new RouteResolver(stores.config, stores.sessions),
    sessions: stores.sessions,
    transcripts: stores.transcripts,
    authProfiles: stores.authProfiles,
    tokenResolver: createTokenResolverMock(),
    orchestrator: createRunOrchestratorMock(),
    health: stores.health,
    ...routerOptions,
    api,
  });
}
