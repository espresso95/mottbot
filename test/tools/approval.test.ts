import { describe, expect, it } from "vitest";
import {
  buildToolApprovalAuditRecord,
  buildToolApprovalPrompt,
  evaluateToolApproval,
  requiresToolApproval,
  type ToolApproval,
} from "../../src/tools/approval.js";
import type { ToolDefinition } from "../../src/tools/registry.js";

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "restart_service",
    description: "Restart the service.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    maxOutputBytes: 4_000,
    sideEffect: "process_control",
    enabled: false,
    ...overrides,
  };
}

describe("tool approval design", () => {
  it("does not require approval for read-only tools", () => {
    const definition = tool({ name: "health", sideEffect: "read_only", enabled: true });

    expect(requiresToolApproval(definition)).toBe(false);
    expect(evaluateToolApproval(definition, undefined, 100)).toMatchObject({
      allowed: true,
      code: "read_only",
    });
    expect(buildToolApprovalPrompt(definition, 100)).toBeUndefined();
  });

  it("requires fresh matching approvals for side-effecting tools", () => {
    const definition = tool();
    const approval: ToolApproval = {
      toolName: "restart_service",
      approvedByUserId: "8323483502",
      reason: "operator requested restart",
      approvedAt: 100,
      expiresAt: 200,
    };

    expect(evaluateToolApproval(definition, undefined, 100)).toMatchObject({
      allowed: false,
      code: "approval_required",
    });
    expect(evaluateToolApproval(definition, { ...approval, toolName: "other" }, 100)).toMatchObject({
      allowed: false,
      code: "approval_mismatch",
    });
    expect(evaluateToolApproval(definition, approval, 200)).toMatchObject({
      allowed: false,
      code: "approval_expired",
    });
    expect(evaluateToolApproval(definition, approval, 199)).toMatchObject({
      allowed: true,
      code: "approved",
    });
  });

  it("builds operator approval prompts with expiration", () => {
    expect(buildToolApprovalPrompt(tool({ sideEffect: "local_write" }), 1_000, 30_000)).toEqual({
      toolName: "restart_service",
      sideEffect: "local_write",
      promptText: "Approve restart_service to write local files? Approval expires in 30 seconds.",
      expiresAt: 31_000,
    });
  });

  it("builds audit records for approval decisions", () => {
    const definition = tool();
    const approval: ToolApproval = {
      toolName: "restart_service",
      approvedByUserId: "8323483502",
      reason: "operator requested restart",
      approvedAt: 100,
      expiresAt: 200,
    };
    const decision = evaluateToolApproval(definition, approval, 150);

    expect(
      buildToolApprovalAuditRecord({
        definition,
        decision,
        requestedAt: 120,
        decidedAt: 150,
        approval,
      }),
    ).toEqual({
      toolName: "restart_service",
      sideEffect: "process_control",
      allowed: true,
      decisionCode: "approved",
      requestedAt: 120,
      decidedAt: 150,
      approvedByUserId: "8323483502",
      reason: "operator requested restart",
    });
  });
});
