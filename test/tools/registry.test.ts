import { describe, expect, it } from "vitest";
import {
  createDefaultToolRegistry,
  ToolRegistry,
  ToolRegistryError,
  type ToolDefinition,
} from "../../src/tools/registry.js";

function readOnlyTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "lookup_value",
    description: "Lookup a test value.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          minLength: 1,
          maxLength: 20,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    maxOutputBytes: 4_000,
    sideEffect: "read_only",
    enabled: true,
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  it("exposes only enabled read-only model declarations by default", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.listModelDeclarations()).toEqual([
      {
        name: "mottbot_health_snapshot",
        description: "Read a token-free Mottbot runtime health snapshot.",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("rejects unknown and disabled tools", () => {
    const registry = createDefaultToolRegistry();

    expect(() => registry.resolve("missing_tool")).toThrow(ToolRegistryError);
    expect(() => registry.resolve("mottbot_restart_service")).toThrow("disabled");
  });

  it("validates tool input against the declared schema", () => {
    const registry = new ToolRegistry([readOnlyTool()]);

    expect(registry.validateInput("lookup_value", { key: "abc", limit: 3 })).toEqual({ key: "abc", limit: 3 });
    expect(() => registry.validateInput("lookup_value", { limit: 3 })).toThrow("$.key is required");
    expect(() => registry.validateInput("lookup_value", { key: "abc", extra: true })).toThrow("$.extra is not allowed");
    expect(() => registry.validateInput("lookup_value", { key: "abc", limit: 1.5 })).toThrow(
      "$.limit must be an integer",
    );
  });

  it("requires enabled tools to be read-only", () => {
    expect(
      () =>
        new ToolRegistry([
          readOnlyTool({
            sideEffect: "process_control",
          }),
        ]),
    ).toThrow("must stay disabled");
  });

  it("accepts disabled side-effecting tool definitions without exposing them", () => {
    const registry = new ToolRegistry([
      readOnlyTool(),
      readOnlyTool({
        name: "restart_service",
        description: "Restart the service.",
        sideEffect: "process_control",
        enabled: false,
      }),
    ]);

    expect(registry.listEnabled().map((definition) => definition.name)).toEqual(["lookup_value"]);
    expect(() => registry.resolve("restart_service")).toThrow("disabled");
  });

  it("rejects malformed tool definitions", () => {
    expect(() => new ToolRegistry([readOnlyTool({ name: "bad.name" })])).toThrow("Invalid tool name");
    expect(() => new ToolRegistry([readOnlyTool({ timeoutMs: 0 })])).toThrow("timeout");
    expect(() => new ToolRegistry([readOnlyTool(), readOnlyTool()])).toThrow("Duplicate");
  });
});
