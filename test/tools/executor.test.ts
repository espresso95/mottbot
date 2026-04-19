import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../../src/tools/executor.js";
import { ToolRegistry, type ToolDefinition } from "../../src/tools/registry.js";
import { FakeClock, createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

function readOnlyTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "lookup_value",
    description: "Lookup a test value.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    maxOutputBytes: 4_000,
    sideEffect: "read_only",
    enabled: true,
    ...overrides,
  };
}

describe("ToolExecutor", () => {
  it("executes the built-in read-only health snapshot", async () => {
    const stores = createStores();
    try {
      const executor = new ToolExecutor(new ToolRegistry(), {
        clock: stores.clock,
        health: stores.health,
      });

      const result = await executor.execute({
        id: "call-1",
        name: "mottbot_health_snapshot",
        arguments: {},
      });

      expect(result.isError).toBe(false);
      expect(result.toolName).toBe("mottbot_health_snapshot");
      expect(result.contentText).toContain('"status"');
      expect(result.outputBytes).toBeGreaterThan(0);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("returns tool-result messages for provider continuation", async () => {
    const clock = new FakeClock(123);
    const executor = new ToolExecutor(new ToolRegistry([readOnlyTool()]), {
      clock,
      handlers: {
        lookup_value: () => "value",
      },
    });

    const result = await executor.execute({
      id: "call-2",
      name: "lookup_value",
      arguments: {},
    });

    expect(executor.toToolResultMessage(result)).toEqual({
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "lookup_value",
      content: [{ type: "text", text: "value" }],
      details: {
        elapsedMs: 0,
        outputBytes: 5,
        truncated: false,
      },
      isError: false,
      timestamp: 123,
    });
  });

  it("returns errors for unknown, disabled, or invalid tools", async () => {
    const executor = new ToolExecutor(new ToolRegistry([readOnlyTool({ enabled: false })]), {
      clock: new FakeClock(),
    });

    const result = await executor.execute({
      id: "call-3",
      name: "lookup_value",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("disabled_tool");
    expect(result.contentText).toContain("disabled");
  });

  it("enforces handler timeouts", async () => {
    const executor = new ToolExecutor(new ToolRegistry([readOnlyTool({ timeoutMs: 1 })]), {
      clock: new FakeClock(),
      handlers: {
        lookup_value: () => new Promise((resolve) => setTimeout(resolve, 25)),
      },
    });

    const result = await executor.execute({
      id: "call-4",
      name: "lookup_value",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.errorCode).toBe("tool_timeout");
  });

  it("truncates oversized output", async () => {
    const executor = new ToolExecutor(new ToolRegistry([readOnlyTool({ maxOutputBytes: 8 })]), {
      clock: new FakeClock(),
      handlers: {
        lookup_value: () => "abcdefghijklmnop",
      },
    });

    const result = await executor.execute({
      id: "call-5",
      name: "lookup_value",
      arguments: {},
    });

    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.outputBytes).toBeLessThanOrEqual(8);
  });
});
