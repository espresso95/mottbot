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
      role: "assistant",
      content: [{ type: "text", text: "completed" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      stopReason: "stop",
      timestamp: 1,
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

  it("normalizes assistant history before calling pi-ai", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    let capturedContext: any;
    streamSimple.mockImplementationOnce(async (_model, context) => {
      capturedContext = context;
      return createEventStream([{ type: "done", message: { content: [{ type: "text", text: "ok" }] } }]);
    });
    const transport = new CodexTransport(stores.database, stores.logger);
    const result = await transport.stream({
      sessionKey: "session-history",
      modelRef: "openai-codex/gpt-5.4",
      transport: "websocket",
      auth: {
        profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
        accessToken: "access",
        apiKey: "api",
      },
      systemPrompt: "Base instructions.",
      messages: [
        { role: "system", content: "Earlier conversation summary.", timestamp: 1 },
        { role: "user", content: "first", timestamp: 2 },
        { role: "assistant", content: "previous answer", timestamp: 3 },
        { role: "user", content: "next", timestamp: 4 },
      ],
    });

    expect(result.text).toBe("ok");
    expect(capturedContext.systemPrompt).toContain("Base instructions.");
    expect(capturedContext.systemPrompt).toContain("Earlier conversation summary.");
    expect(capturedContext.messages).toHaveLength(3);
    expect(capturedContext.messages[1]).toMatchObject({
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      stopReason: "stop",
      content: [{ type: "text", text: "previous answer" }],
    });
  });

  it("does not pass native file bytes through the current pi-ai provider boundary", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    let capturedContext: any;
    streamSimple.mockImplementationOnce(async (_model, context) => {
      capturedContext = context;
      return createEventStream([{ type: "done", message: { content: [{ type: "text", text: "ok" }] } }]);
    });
    const transport = new CodexTransport(stores.database, stores.logger);

    await transport.stream({
      sessionKey: "session-file-fallback",
      modelRef: "openai-codex/gpt-5.4",
      transport: "websocket",
      auth: {
        profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
        accessToken: "access",
        apiKey: "api",
      },
      messages: [
        {
          role: "user",
          timestamp: 1,
          content: [
            { type: "text", text: "Inspect this file." },
            { type: "file", data: "c2VjcmV0", mimeType: "application/pdf", fileName: "report.pdf" },
          ],
        },
      ],
    });

    expect(capturedContext.messages[0].content).toEqual([
      { type: "text", text: "Inspect this file." },
      {
        type: "text",
        text: "[Native file report.pdf (application/pdf) omitted: the current Codex provider adapter supports text and images only.]",
      },
    ]);
    expect(JSON.stringify(capturedContext)).not.toContain("c2VjcmV0");
  });

  it("passes tool declarations and normalizes streamed tool calls", async () => {
    const stores = createStores();
    cleanup.push(() => {
      stores.database.close();
      removeTempDir(stores.tempDir);
    });
    let capturedContext: any;
    streamSimple.mockImplementationOnce(async (_model, context) => {
      capturedContext = context;
      return createEventStream([
        {
          type: "toolcall_start",
          contentIndex: 0,
          partial: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "mottbot_health_snapshot", arguments: {} }],
          },
        },
        {
          type: "toolcall_end",
          toolCall: { type: "toolCall", id: "call-1", name: "mottbot_health_snapshot", arguments: {} },
        },
        {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "mottbot_health_snapshot", arguments: {} }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: "gpt-5.4",
            usage: {},
            stopReason: "toolUse",
            timestamp: 1,
          },
        },
      ]);
    });
    const transport = new CodexTransport(stores.database, stores.logger);
    const starts: string[] = [];
    const completed: string[] = [];

    const result = await transport.stream({
      sessionKey: "session-tools",
      modelRef: "openai-codex/gpt-5.4",
      transport: "websocket",
      auth: {
        profile: { profileId: "p1", provider: "openai-codex", source: "local_oauth", createdAt: 1, updatedAt: 1 },
        accessToken: "access",
        apiKey: "api",
      },
      messages: [{ role: "user", content: "status?", timestamp: 1 }],
      tools: [
        {
          name: "mottbot_health_snapshot",
          description: "Read health.",
          inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      ],
      onToolCallStart: async (toolCall) => {
        if (toolCall.name) {
          starts.push(toolCall.name);
        }
      },
      onToolCallEnd: async (toolCall) => {
        completed.push(toolCall.name);
      },
    });

    expect(capturedContext.tools).toEqual([
      {
        name: "mottbot_health_snapshot",
        description: "Read health.",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ]);
    expect(starts).toEqual(["mottbot_health_snapshot"]);
    expect(completed).toEqual(["mottbot_health_snapshot"]);
    expect(result.stopReason).toBe("toolUse");
    expect(result.toolCalls).toEqual([
      {
        id: "call-1",
        name: "mottbot_health_snapshot",
        arguments: {},
      },
    ]);
    expect(result.assistantMessage?.stopReason).toBe("toolUse");
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
