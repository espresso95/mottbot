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
        allowedRoles: ["owner", "admin", "trusted", "user"],
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
        allowedRoles: ["owner", "admin"],
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

  it("keeps side-effect approvals mandatory even if policy tries to disable them", () => {
    const definition = tool({
      name: "send_message",
      sideEffect: "telegram_send",
      requiresAdmin: true,
    });
    const policy = createToolPolicyEngine({
      definitions: [definition],
      overrides: {
        send_message: {
          requiresApproval: false,
          dryRun: true,
        },
      },
    }).get(definition.name);

    expect(policy).toMatchObject({
      requiresApproval: true,
      dryRun: true,
    });
  });

  it("applies per-agent policy overrides as additional restrictions", () => {
    const definition = tool();
    const policy = createToolPolicyEngine({
      definitions: [definition],
      overrides: {
        lookup_value: {
          allowedRoles: ["admin", "trusted"],
          allowedChatIds: ["chat-1", "chat-2"],
          maxOutputBytes: 2_000,
        },
      },
    });

    expect(
      policy.evaluate(
        definition,
        { role: "trusted", chatId: "chat-1" },
        {
          override: {
            allowedRoles: ["admin"],
            allowedChatIds: ["chat-2"],
            maxOutputBytes: 1_000,
          },
        },
      ),
    ).toMatchObject({
      allowed: false,
      code: "role_denied",
    });
    expect(
      policy.evaluate(
        definition,
        { role: "admin", chatId: "chat-1" },
        {
          override: {
            allowedRoles: ["admin"],
            allowedChatIds: ["chat-2"],
            maxOutputBytes: 1_000,
          },
        },
      ),
    ).toMatchObject({
      allowed: false,
      code: "chat_denied",
    });
    expect(
      policy.evaluate(
        definition,
        { role: "admin", chatId: "chat-2" },
        {
          override: {
            allowedRoles: ["admin"],
            allowedChatIds: ["chat-2"],
            maxOutputBytes: 1_000,
          },
        },
      ),
    ).toMatchObject({
      allowed: true,
      policy: expect.objectContaining({
        allowedRoles: ["admin"],
        allowedChatIds: ["chat-2"],
        maxOutputBytes: 1_000,
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

  it("renders distinct approval previews for write side-effect classes", () => {
    const localWrite = tool({ name: "local_note", sideEffect: "local_write" });
    const networkWrite = tool({ name: "network_write", sideEffect: "network_write" });
    const telegramSend = tool({ name: "telegram_send", sideEffect: "telegram_send" });
    const githubWrite = tool({ name: "github_write", sideEffect: "github_write" });
    const processControl = tool({ name: "process_control", sideEffect: "process_control" });
    const policy = createToolPolicyEngine({
      definitions: [localWrite, networkWrite, telegramSend, githubWrite, processControl],
    });

    expect(
      buildToolApprovalPreview({ definition: localWrite, policy: policy.get("local_note")!, arguments: {} }),
    ).toContain("write local files");
    expect(
      buildToolApprovalPreview({ definition: networkWrite, policy: policy.get("network_write")!, arguments: {} }),
    ).toContain("write through an external network API");
    expect(
      buildToolApprovalPreview({ definition: telegramSend, policy: policy.get("telegram_send")!, arguments: {} }),
    ).toContain("Telegram Bot API");
    expect(
      buildToolApprovalPreview({ definition: githubWrite, policy: policy.get("github_write")!, arguments: {} }),
    ).toContain("GitHub API");
    expect(
      buildToolApprovalPreview({ definition: processControl, policy: policy.get("process_control")!, arguments: {} }),
    ).toContain("control the local Mottbot process");
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
