import { describe, expect, it } from "vitest";
import {
  buildToolApprovalPreview,
  createToolPolicyEngine,
  createToolRequestFingerprint,
} from "../../src/tools/policy.js";
import type { ToolDefinition } from "../../src/tools/registry.js";

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
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

describe("tool policy engine", () => {
  it("uses conservative defaults by role and side-effect class", () => {
    const readOnly = tool();
    const restart = tool({
      name: "restart_service",
      sideEffect: "process_control",
      requiresAdmin: true,
    });
    const policy = createToolPolicyEngine({ definitions: [readOnly, restart] });

    expect(policy.evaluate(readOnly, { role: "user", chatId: "chat-1" })).toMatchObject({
      allowed: true,
      policy: expect.objectContaining({
        requiresApproval: false,
        allowedRoles: ["admin", "user"],
      }),
    });
    expect(policy.evaluate(restart, { role: "user", chatId: "chat-1" })).toMatchObject({
      allowed: false,
      code: "role_denied",
    });
    expect(policy.evaluate(restart, { role: "admin", chatId: "chat-1" })).toMatchObject({
      allowed: true,
      policy: expect.objectContaining({
        requiresApproval: true,
        allowedRoles: ["admin"],
      }),
    });
  });

  it("applies policy overrides without exceeding tool limits", () => {
    const definition = tool({ maxOutputBytes: 2_000 });
    const policy = createToolPolicyEngine({
      definitions: [definition],
      overrides: {
        lookup_value: {
          allowedRoles: ["admin"],
          allowedChatIds: ["chat-1"],
          maxOutputBytes: 9_000,
        },
      },
    });

    expect(policy.evaluate(definition, { role: "user", chatId: "chat-1" })).toMatchObject({
      allowed: false,
      code: "role_denied",
    });
    expect(policy.evaluate(definition, { role: "admin", chatId: "chat-2" })).toMatchObject({
      allowed: false,
      code: "chat_denied",
    });
    expect(policy.evaluate(definition, { role: "admin", chatId: "chat-1" })).toMatchObject({
      allowed: true,
      policy: expect.objectContaining({
        maxOutputBytes: 2_000,
      }),
    });
  });

  it("rejects overrides for unknown or disabled tools", () => {
    expect(() =>
      createToolPolicyEngine({
        definitions: [tool()],
        overrides: {
          missing_tool: {
            allowedRoles: ["admin"],
          },
        },
      }),
    ).toThrow("unknown or disabled tool");
  });

  it("renders bounded approval previews with sensitive argument redaction", () => {
    const definition = tool({
      name: "restart_service",
      description: "Restart the service.",
      sideEffect: "process_control",
    });
    const policy = createToolPolicyEngine({ definitions: [definition] }).get(definition.name)!;
    const preview = buildToolApprovalPreview({
      definition,
      policy,
      arguments: {
        reason: "operator requested",
        apiToken: "secret-token",
        nested: {
          password: "secret-password",
        },
      },
    });

    expect(preview).toContain("Tool: restart_service");
    expect(preview).toContain("operator requested");
    expect(preview).toContain("[redacted]");
    expect(preview).not.toContain("secret-token");
    expect(preview).not.toContain("secret-password");
  });

  it("creates stable fingerprints independent of object key order", () => {
    expect(
      createToolRequestFingerprint({
        toolName: "lookup_value",
        arguments: { a: 1, b: { c: true, d: "x" } },
      }),
    ).toBe(
      createToolRequestFingerprint({
        toolName: "lookup_value",
        arguments: { b: { d: "x", c: true }, a: 1 },
      }),
    );
  });
});
