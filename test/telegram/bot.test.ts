import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, createInboundEvent, createStores, createTestConfig } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

const handlers = new Map<string, (ctx: any) => Promise<void>>();
let requestHandler: ((req: any, res: any) => void) | undefined;
const botApi = {
  getMe: vi.fn(async () => ({ username: "mottbot" })),
  deleteWebhook: vi.fn(async () => true),
  setWebhook: vi.fn(async () => true),
  setMyCommands: vi.fn(async () => true),
  sendMessage: vi.fn(async () => true),
  answerCallbackQuery: vi.fn(async () => true),
  setMessageReaction: vi.fn(async () => true),
};
const botStart = vi.fn(async () => undefined);
const botStop = vi.fn(async () => undefined);
const webhookCallbackMock = vi.fn(() => vi.fn(async () => undefined));
const serverListen = vi.fn((port: number, host: string, callback?: () => void) => {
  callback?.();
});
const serverClose = vi.fn((callback?: (error?: Error) => void) => {
  callback?.();
});
const serverOnce = vi.fn();
const createServerMock = vi.fn((handler: (req: any, res: any) => void) => {
  requestHandler = handler;
  return {
    listen: serverListen,
    close: serverClose,
    once: serverOnce,
  };
});

class FakeBot {
  api = botApi;
  catch = vi.fn();
  on = vi.fn((event: string, handler: (ctx: any) => Promise<void>) => {
    handlers.set(event, handler);
  });
  start = botStart;
  stop = botStop;
}

vi.mock("grammy", () => ({
  Bot: FakeBot,
  webhookCallback: webhookCallbackMock,
}));

vi.mock("node:http", () => ({
  createServer: createServerMock,
}));

describe("TelegramBotServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    requestHandler = undefined;
  });

  afterEach(() => {
    handlers.clear();
    vi.useRealTimers();
  });

  it("starts and routes accepted messages to the orchestrator", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const { TelegramReactionService } = await import("../../src/telegram/reactions.js");
    const commands = { maybeHandle: vi.fn(async () => false) };
    const access = { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) };
    const session = { sessionKey: "s1" };
    const routes = { resolve: vi.fn(() => session) };
    const orchestrator = { enqueueMessage: vi.fn(async () => undefined) };
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      { begin: vi.fn(() => ({ accepted: true, reason: "new" })), markProcessed: vi.fn(), release: vi.fn() } as any,
      access as any,
      commands as any,
      routes as any,
      orchestrator as any,
      new TelegramReactionService(botApi as any),
    );
    await server.start();
    await handlers.get("message")?.({
      update: { update_id: 1 },
      message: {
        message_id: 42,
        text: "hello",
        chat: { id: 1, type: "private" },
        from: { id: 2, username: "user" },
      },
    });

    expect(botApi.getMe).toHaveBeenCalled();
    expect(botApi.setMyCommands).toHaveBeenCalledWith(
      expect.arrayContaining([
        { command: "help", description: "Show available commands" },
        { command: "project", description: "Run Project Mode tasks" },
        { command: "status", description: "Show session status" },
      ]),
    );
    expect(commands.maybeHandle).toHaveBeenCalled();
    expect(access.evaluate).toHaveBeenCalled();
    expect(routes.resolve).toHaveBeenCalled();
    expect(botApi.setMessageReaction).toHaveBeenCalledWith("1", 42, [{ type: "emoji", emoji: "\u{1F440}" }], {});
    expect(orchestrator.enqueueMessage).toHaveBeenCalledWith({
      event: expect.objectContaining(
        createInboundEvent({
          chatId: "1",
          fromUserId: "2",
          fromUsername: "user",
          messageId: 42,
          updateId: 1,
          text: "hello",
        }),
      ),
      session,
    });
    await server.stop();
    expect(botStop).toHaveBeenCalled();
  });

  it("routes callback query buttons through the command router", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const commands = {
      maybeHandle: vi.fn(async () => false),
      maybeHandleCallback: vi.fn(async () => true),
    };
    const updates = {
      begin: vi.fn(() => ({ accepted: true, reason: "new" })),
      markProcessed: vi.fn(),
      release: vi.fn(),
    };
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(456),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      updates as any,
      { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) } as any,
      commands as any,
      { resolve: vi.fn() } as any,
      { enqueueMessage: vi.fn(async () => undefined) } as any,
    );
    await server.start();
    await handlers.get("callback_query:data")?.({
      update: { update_id: 77 },
      callbackQuery: {
        id: "callback-77",
        data: "mb:ta:approval-1",
        message: {
          message_id: 55,
          message_thread_id: 9,
          chat: { id: -1001, type: "supergroup" },
        },
        from: { id: 2, username: "user" },
      },
    });

    expect(commands.maybeHandleCallback).toHaveBeenCalledWith({
      updateId: 77,
      callbackQueryId: "callback-77",
      chatId: "-1001",
      chatType: "supergroup",
      messageId: 55,
      threadId: 9,
      fromUserId: "2",
      fromUsername: "user",
      data: "mb:ta:approval-1",
      arrivedAt: 456,
    });
    expect(updates.markProcessed).toHaveBeenCalledWith({
      updateId: 77,
      chatId: "-1001",
      messageId: 55,
    });
    expect(updates.release).not.toHaveBeenCalled();
  });

  it("answers unsupported callback query buttons", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const commands = {
      maybeHandle: vi.fn(async () => false),
      maybeHandleCallback: vi.fn(async () => false),
    };
    const updates = {
      begin: vi.fn(() => ({ accepted: true, reason: "new" })),
      markProcessed: vi.fn(),
      release: vi.fn(),
    };
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      updates as any,
      { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) } as any,
      commands as any,
      { resolve: vi.fn() } as any,
      { enqueueMessage: vi.fn(async () => undefined) } as any,
    );
    await server.start();
    await handlers.get("callback_query:data")?.({
      update: { update_id: 78 },
      callbackQuery: {
        id: "callback-78",
        data: "unsupported",
        message: {
          message_id: 56,
          chat: { id: 1, type: "private" },
        },
        from: { id: 2, username: "user" },
      },
    });

    expect(botApi.answerCallbackQuery).toHaveBeenCalledWith("callback-78", {
      text: "Unsupported button.",
      show_alert: true,
    });
    expect(updates.markProcessed).toHaveBeenCalledWith({
      updateId: 78,
      chatId: "1",
      messageId: 56,
    });
  });

  it("records allowed Telegram reaction updates as system context", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const { TelegramReactionService } = await import("../../src/telegram/reactions.js");
    const stores = createStores({
      telegram: {
        reactions: {
          enabled: true,
          ackEmoji: "\u{1F440}",
          removeAckAfterReply: false,
          notifications: "all",
        },
      } as any,
    });
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:1:user:2",
        chatId: "1",
        userId: "2",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const server = new TelegramBotServer(
        stores.config,
        stores.clock,
        stores.logger,
        stores.updateStore,
        { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) } as any,
        { maybeHandle: vi.fn(async () => false) } as any,
        { resolve: vi.fn(() => session) } as any,
        { enqueueMessage: vi.fn(async () => undefined) } as any,
        new TelegramReactionService(botApi as any),
        stores.transcripts,
        stores.messageStore,
      );
      await server.start();
      await handlers.get("message_reaction")?.({
        update: {
          update_id: 99,
          message_reaction: {
            chat: { id: 1, type: "private" },
            message_id: 42,
            user: { id: 2, username: "user" },
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
          },
        },
      });

      expect(stores.transcripts.listRecent(session.sessionKey)).toEqual([
        expect.objectContaining({
          role: "system",
          telegramMessageId: 42,
          contentText: "Telegram reaction added \u{1F44D} by @user on msg 42.",
        }),
      ]);
      expect(stores.updateStore.begin(99)).toEqual({ accepted: false, reason: "processed" });
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("ignores own-scope reaction updates for messages the bot did not send", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const { TelegramReactionService } = await import("../../src/telegram/reactions.js");
    const stores = createStores();
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:1:user:2",
        chatId: "1",
        userId: "2",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const server = new TelegramBotServer(
        stores.config,
        stores.clock,
        stores.logger,
        stores.updateStore,
        { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) } as any,
        { maybeHandle: vi.fn(async () => false) } as any,
        { resolve: vi.fn(() => session) } as any,
        { enqueueMessage: vi.fn(async () => undefined) } as any,
        new TelegramReactionService(botApi as any),
        stores.transcripts,
        stores.messageStore,
      );
      await server.start();
      await handlers.get("message_reaction")?.({
        update: {
          update_id: 100,
          message_reaction: {
            chat: { id: 1, type: "private" },
            message_id: 42,
            user: { id: 2, username: "user" },
            old_reaction: [],
            new_reaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
          },
        },
      });

      expect(stores.transcripts.listRecent(session.sessionKey)).toEqual([]);
      expect(stores.updateStore.begin(100)).toEqual({ accepted: false, reason: "processed" });
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("backs off and retries when Telegram reports another active poller", async () => {
    vi.useFakeTimers();
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    botStart
      .mockRejectedValueOnce(Object.assign(new Error("409: Conflict"), { error_code: 409 }))
      .mockResolvedValueOnce(undefined);
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(),
      logger as any,
      { begin: vi.fn(() => ({ accepted: true, reason: "new" })), markProcessed: vi.fn(), release: vi.fn() } as any,
      { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) } as any,
      { maybeHandle: vi.fn(async () => false) } as any,
      { resolve: vi.fn(() => ({ sessionKey: "s1" })) } as any,
      { enqueueMessage: vi.fn(async () => undefined) } as any,
      undefined,
      {} as any,
      {} as any,
    );

    const startPromise = server.start();
    await vi.waitFor(() => expect(botStart).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await startPromise;

    expect(botStart).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { retryMs: 30_000 },
      "Telegram polling conflict detected. Another getUpdates consumer is using this bot token; retrying.",
    );
  });

  it("short-circuits handled commands", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const commands = { maybeHandle: vi.fn(async () => true) };
    const orchestrator = { enqueueMessage: vi.fn(async () => undefined) };
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      { begin: vi.fn(() => ({ accepted: true, reason: "new" })), markProcessed: vi.fn(), release: vi.fn() } as any,
      { evaluate: vi.fn() } as any,
      commands as any,
      { resolve: vi.fn() } as any,
      orchestrator as any,
    );
    await server.start();
    await handlers.get("message")?.({
      update: { update_id: 1 },
      message: {
        message_id: 42,
        text: "/status",
        chat: { id: 1, type: "private" },
        from: { id: 2, username: "user" },
      },
    });
    expect(orchestrator.enqueueMessage).not.toHaveBeenCalled();
  });

  it("ignores duplicate updates", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const commands = { maybeHandle: vi.fn(async () => false) };
    const access = { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) };
    const session = { sessionKey: "s1" };
    const routes = { resolve: vi.fn(() => session) };
    const orchestrator = { enqueueMessage: vi.fn(async () => undefined) };
    const updates = {
      begin: vi
        .fn()
        .mockReturnValueOnce({ accepted: true, reason: "new" })
        .mockReturnValueOnce({ accepted: false, reason: "processed" }),
      markProcessed: vi.fn(),
      release: vi.fn(),
    };
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      updates as any,
      access as any,
      commands as any,
      routes as any,
      orchestrator as any,
    );
    await server.start();
    const ctx = {
      update: { update_id: 1 },
      message: {
        message_id: 42,
        text: "hello",
        chat: { id: 1, type: "private" },
        from: { id: 2, username: "user" },
      },
    };
    await handlers.get("message")?.(ctx);
    await handlers.get("message")?.(ctx);
    expect(orchestrator.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it("marks access-rejected updates as processed without enqueueing a run", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const updates = {
      begin: vi.fn(() => ({ accepted: true, reason: "new" })),
      markProcessed: vi.fn(),
      release: vi.fn(),
    };
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      updates as any,
      { evaluate: vi.fn(() => ({ allow: false, reason: "mention_required" })) } as any,
      { maybeHandle: vi.fn(async () => false) } as any,
      { resolve: vi.fn() } as any,
      { enqueueMessage: vi.fn(async () => undefined) } as any,
    );
    await server.start();
    await handlers.get("message")?.({
      update: { update_id: 7 },
      message: {
        message_id: 70,
        text: "hello",
        chat: { id: -1, type: "group" },
        from: { id: 2, username: "user" },
      },
    });

    expect(updates.markProcessed).toHaveBeenCalledWith({
      updateId: 7,
      chatId: "-1",
      messageId: 70,
    });
    expect(updates.release).not.toHaveBeenCalled();
  });

  it("rejects safety-limit violations with a Telegram reply", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const updates = {
      begin: vi.fn(() => ({ accepted: true, reason: "new" })),
      markProcessed: vi.fn(),
      release: vi.fn(),
    };
    const commands = { maybeHandle: vi.fn(async () => false) };
    const access = { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) };
    const orchestrator = { enqueueMessage: vi.fn(async () => undefined) };
    const server = new TelegramBotServer(
      createTestConfig({
        behavior: { maxInboundTextChars: 5 } as any,
      }),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      updates as any,
      access as any,
      commands as any,
      { resolve: vi.fn() } as any,
      orchestrator as any,
    );
    await server.start();
    await handlers.get("message")?.({
      update: { update_id: 9 },
      message: {
        message_id: 90,
        text: "too long",
        chat: { id: 1, type: "private" },
        from: { id: 2, username: "user" },
      },
    });

    expect(botApi.sendMessage).toHaveBeenCalledWith("1", "Message is too long. Limit is 5 characters.", {
      reply_parameters: { message_id: 90 },
    });
    expect(commands.maybeHandle).not.toHaveBeenCalled();
    expect(access.evaluate).not.toHaveBeenCalled();
    expect(orchestrator.enqueueMessage).not.toHaveBeenCalled();
    expect(updates.markProcessed).toHaveBeenCalledWith({
      updateId: 9,
      chatId: "1",
      messageId: 90,
    });
    expect(updates.release).not.toHaveBeenCalled();
  });

  it("marks safety-limit violations processed when the rejection reply fails", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const updates = {
      begin: vi.fn(() => ({ accepted: true, reason: "new" })),
      markProcessed: vi.fn(),
      release: vi.fn(),
    };
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
    botApi.sendMessage.mockRejectedValueOnce(new Error("send failed"));
    const server = new TelegramBotServer(
      createTestConfig({
        behavior: { maxInboundTextChars: 5 } as any,
      }),
      new FakeClock(),
      logger as any,
      updates as any,
      { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) } as any,
      { maybeHandle: vi.fn(async () => false) } as any,
      { resolve: vi.fn() } as any,
      { enqueueMessage: vi.fn(async () => undefined) } as any,
    );
    await server.start();
    await handlers.get("message")?.({
      update: { update_id: 10 },
      message: {
        message_id: 100,
        text: "too long",
        chat: { id: 1, type: "private" },
        from: { id: 2, username: "user" },
      },
    });

    expect(logger.warn).toHaveBeenCalled();
    expect(updates.markProcessed).toHaveBeenCalledWith({
      updateId: 10,
      chatId: "1",
      messageId: 100,
    });
    expect(updates.release).not.toHaveBeenCalled();
  });

  it("releases inflight updates when enqueueing a run fails", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const updates = {
      begin: vi.fn(() => ({ accepted: true, reason: "new" })),
      markProcessed: vi.fn(),
      release: vi.fn(),
    };
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      updates as any,
      { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) } as any,
      { maybeHandle: vi.fn(async () => false) } as any,
      { resolve: vi.fn(() => ({ sessionKey: "s1" })) } as any,
      {
        enqueueMessage: vi.fn(async () => {
          throw new Error("queue failed");
        }),
      } as any,
    );
    await server.start();
    await expect(
      handlers.get("message")?.({
        update: { update_id: 8 },
        message: {
          message_id: 80,
          text: "hello",
          chat: { id: 1, type: "private" },
          from: { id: 2, username: "user" },
        },
      }),
    ).rejects.toThrow("queue failed");

    expect(updates.markProcessed).not.toHaveBeenCalled();
    expect(updates.release).toHaveBeenCalledWith(8);
  });

  it("starts in webhook mode and closes the local server on stop", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const server = new TelegramBotServer(
      createTestConfig({
        telegram: {
          polling: false,
          webhook: {
            publicUrl: "https://example.com/base/",
            path: "/telegram/webhook",
            host: "127.0.0.1",
            port: 9090,
            secretToken: "secret",
          },
        } as any,
      }),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      { begin: vi.fn(() => ({ accepted: true, reason: "new" })), markProcessed: vi.fn(), release: vi.fn() } as any,
      { evaluate: vi.fn(() => ({ allow: true, reason: "private" })) } as any,
      { maybeHandle: vi.fn(async () => false) } as any,
      { resolve: vi.fn(() => ({ sessionKey: "s1" })) } as any,
      { enqueueMessage: vi.fn(async () => undefined) } as any,
      undefined,
      {} as any,
      {} as any,
    );
    await server.start();

    expect(botStart).not.toHaveBeenCalled();
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(serverListen).toHaveBeenCalledWith(9090, "127.0.0.1", expect.any(Function));
    expect(botApi.setWebhook).toHaveBeenCalledWith("https://example.com/telegram/webhook", {
      secret_token: "secret",
      allowed_updates: ["message", "message_reaction", "callback_query"],
    });
    expect(requestHandler).toBeTypeOf("function");

    await server.stop();
    expect(serverClose).toHaveBeenCalledTimes(1);
  });
});
