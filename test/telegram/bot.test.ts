import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock, createInboundEvent, createTestConfig } from "../helpers/fakes.js";

const handlers = new Map<string, (ctx: any) => Promise<void>>();
const botApi = {
  getMe: vi.fn(async () => ({ username: "mottbot" })),
};
const botStart = vi.fn(async () => undefined);
const botStop = vi.fn(async () => undefined);

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
}));

describe("TelegramBotServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  afterEach(() => {
    handlers.clear();
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

  it("short-circuits handled commands", async () => {
    const { TelegramBotServer } = await import("../../src/telegram/bot.js");
    const commands = { maybeHandle: vi.fn(async () => true) };
    const orchestrator = { enqueueMessage: vi.fn(async () => undefined) };
    const server = new TelegramBotServer(
      createTestConfig(),
      new FakeClock(),
      { info: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
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
});
