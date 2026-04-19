import { describe, expect, it } from "vitest";
import {
  assistantMessageFromUnknown,
  collectCodexToolCallsFromEvent,
  collectCodexToolCallsFromMessage,
  collectCodexToolProgressFromEvent,
  normalizeCodexToolCall,
} from "../../src/codex/tool-calls.js";

describe("codex tool-call normalization", () => {
  it("normalizes complete tool-call content", () => {
    expect(
      normalizeCodexToolCall({
        type: "toolCall",
        id: "call-1",
        name: "mottbot_health_snapshot",
        arguments: { verbose: false },
      }),
    ).toEqual({
      id: "call-1",
      name: "mottbot_health_snapshot",
      arguments: { verbose: false },
    });
  });

  it("rejects malformed tool-call content", () => {
    expect(normalizeCodexToolCall({ type: "toolCall", name: "missing-id" })).toBeUndefined();
    expect(normalizeCodexToolCall({ type: "text", text: "not a tool" })).toBeUndefined();
  });

  it("collects tool calls from assistant messages", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        {
          type: "toolCall",
          id: "call-1",
          name: "mottbot_health_snapshot",
          arguments: {},
        },
      ],
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.4",
      usage: {},
      stopReason: "toolUse",
      timestamp: 1,
    };

    expect(assistantMessageFromUnknown(message)).toBe(message);
    expect(collectCodexToolCallsFromMessage(message)).toEqual([
      {
        id: "call-1",
        name: "mottbot_health_snapshot",
        arguments: {},
      },
    ]);
  });

  it("collects completed tool calls from stream events", () => {
    expect(
      collectCodexToolCallsFromEvent({
        type: "toolcall_end",
        toolCall: {
          type: "toolCall",
          id: "call-2",
          name: "mottbot_health_snapshot",
          arguments: {},
        },
      }),
    ).toEqual([
      {
        id: "call-2",
        name: "mottbot_health_snapshot",
        arguments: {},
      },
    ]);
  });

  it("collects partial progress from stream event partial content", () => {
    expect(
      collectCodexToolProgressFromEvent({
        type: "toolcall_delta",
        contentIndex: 0,
        partial: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-3",
              name: "mottbot_health_snapshot",
              arguments: { current: true },
            },
          ],
        },
      }),
    ).toEqual({
      id: "call-3",
      name: "mottbot_health_snapshot",
      arguments: { current: true },
    });
  });
});
