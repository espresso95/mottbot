import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexTransport } from "../../src/codex/transport.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

const streamSimple = vi.fn();
const completeSimple = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple,
  completeSimple,
}));

async function* createEventStream(events: unknown[]) {
  for (const event of events) {
    yield event;
  }
}

describe("CodexTransport", () => {
  const cleanup: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("streams text deltas and stores transport state", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    streamSimple.mockResolvedValueOnce(
      createEventStream([
        { type: "start" },
        { type: "text_delta", delta: "hello " },
        { type: "text_delta", delta: "world" },
        {
          type: "done",
          usage: { input: 1, output: 2 },
        },
      ]),
    );
    const transport = new CodexTransport(stores.database, stores.logger);
    const deltas: string[] = [];
    const result = await transport.stream({
      sessionKey: "session-1",
      modelRef: "openai-codex/gpt-5.4",
      transport: "websocket",
      auth: {
        profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
        accessToken: "access",
        apiKey: "api",
      },
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      onTextDelta: async (delta) => {
        deltas.push(delta);
      },
    });

    expect(result.text).toBe("hello world");
    expect(deltas).toEqual(["hello ", "world"]);
    const state = stores.database.db
      .prepare("select last_transport from transport_state where session_key = ?")
      .get("session-1") as { last_transport: string };
    expect(state.last_transport).toBe("websocket");
  });

  it("falls back from websocket to sse in auto mode", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    streamSimple
      .mockRejectedValueOnce(new Error("websocket handshake failed"))
      .mockResolvedValueOnce(
        createEventStream([{ type: "done", message: { content: [{ type: "text", text: "fallback" }] } }]),
      );
    const transport = new CodexTransport(stores.database, stores.logger);
    const result = await transport.stream({
      sessionKey: "session-2",
      modelRef: "openai-codex/gpt-5.4",
      transport: "auto",
      auth: {
        profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
        accessToken: "access",
        apiKey: "api",
      },
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    expect(result.transport).toBe("sse");
  });

  it("uses completeSimple when streamSimple is not async iterable", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    streamSimple.mockResolvedValueOnce({ plain: true });
    completeSimple.mockResolvedValueOnce({
      message: { content: [{ type: "text", text: "completed" }] },
      usage: { total: 1 },
    });
    const transport = new CodexTransport(stores.database, stores.logger);
    const onStart = vi.fn(async () => undefined);
    const result = await transport.stream({
      sessionKey: "session-3",
      modelRef: "openai-codex/gpt-5.4",
      transport: "sse",
      auth: {
        profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
        accessToken: "access",
        apiKey: "api",
      },
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      onStart,
    });
    expect(result.text).toBe("completed");
    expect(completeSimple).toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("preserves the degraded websocket window across successful sse retries", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    streamSimple
      .mockRejectedValueOnce(new Error("websocket handshake failed"))
      .mockResolvedValueOnce(
        createEventStream([{ type: "done", message: { content: [{ type: "text", text: "fallback" }] } }]),
      )
      .mockResolvedValueOnce(
        createEventStream([{ type: "done", message: { content: [{ type: "text", text: "cached" }] } }]),
      );
    const transport = new CodexTransport(stores.database, stores.logger);

    await transport.stream({
      sessionKey: "session-4",
      modelRef: "openai-codex/gpt-5.4",
      transport: "auto",
      auth: {
        profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
        accessToken: "access",
        apiKey: "api",
      },
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });

    const afterFallback = stores.database.db
      .prepare("select websocket_degraded_until, last_transport from transport_state where session_key = ?")
      .get("session-4") as { websocket_degraded_until: number | null; last_transport: string };
    expect(afterFallback.last_transport).toBe("sse");
    expect(afterFallback.websocket_degraded_until).toBeTypeOf("number");
    expect(afterFallback.websocket_degraded_until).toBeGreaterThan(Date.now());

    await transport.stream({
      sessionKey: "session-4",
      modelRef: "openai-codex/gpt-5.4",
      transport: "auto",
      auth: {
        profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
        accessToken: "access",
        apiKey: "api",
      },
      messages: [{ role: "user", content: "again", timestamp: 2 }],
    });

    const afterSecondAttempt = stores.database.db
      .prepare("select websocket_degraded_until, last_transport from transport_state where session_key = ?")
      .get("session-4") as { websocket_degraded_until: number | null; last_transport: string };
    expect(afterSecondAttempt.last_transport).toBe("sse");
    expect(afterSecondAttempt.websocket_degraded_until).toBe(afterFallback.websocket_degraded_until);
  });

  it("does not fall back after websocket progress has already started", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    streamSimple.mockResolvedValueOnce(
      createEventStream([
        { type: "start" },
        { type: "text_delta", delta: "partial" },
        { type: "error", error: { errorMessage: "websocket stream broke" } },
      ]),
    );
    const transport = new CodexTransport(stores.database, stores.logger);
    const deltas: string[] = [];

    await expect(
      transport.stream({
        sessionKey: "session-5",
        modelRef: "openai-codex/gpt-5.4",
        transport: "auto",
        auth: {
          profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
          accessToken: "access",
          apiKey: "api",
        },
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
        onTextDelta: async (delta) => {
          deltas.push(delta);
        },
      }),
    ).rejects.toThrow("websocket stream broke");

    expect(deltas).toEqual(["partial"]);
    expect(streamSimple).toHaveBeenCalledTimes(1);
  });
});
