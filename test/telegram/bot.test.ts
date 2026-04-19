import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, createInboundEvent, createTestConfig } from "../helpers/fakes.js";

const handlers = new Map<string, (ctx: any) => Promise<void>>();
let requestHandler: ((req: any, res: any) => void) | undefined;
const botApi = {
  getMe: vi.fn(async () => ({ username: "mottbot" })),
  deleteWebhook: vi.fn(async () => true),
  setWebhook: vi.fn(async () => true),
  sendMessage: vi.fn(async () => true),
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
    expect(commands.maybeHandle).toHaveBeenCalled();
    expect(access.evaluate).toHaveBeenCalled();
    expect(routes.resolve).toHaveBeenCalled();
    expect(orchestrator.enqueueMessage).toHaveBeenCalledWith({
      event: expect.objectContaining(createInboundEvent({ chatId: "1", fromUserId: "2", fromUsername: "user", messageId: 42, updateId: 1, text: "hello" })),
      session,
    });
    await server.stop();
    expect(botStop).toHaveBeenCalled();
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
      begin: vi.fn()
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
    );
    await server.start();

    expect(botStart).not.toHaveBeenCalled();
    expect(createServerMock).toHaveBeenCalledTimes(1);
    expect(serverListen).toHaveBeenCalledWith(9090, "127.0.0.1", expect.any(Function));
    expect(botApi.setWebhook).toHaveBeenCalledWith("https://example.com/telegram/webhook", {
      secret_token: "secret",
      allowed_updates: ["message"],
    });
    expect(requestHandler).toBeTypeOf("function");

    await server.stop();
    expect(serverClose).toHaveBeenCalledTimes(1);
  });
});
