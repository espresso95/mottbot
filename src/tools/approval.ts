import type { ToolDefinition, ToolSideEffect } from "./registry.js";

export type ToolApproval = {
  toolName: string;
  approvedByUserId: string;
  reason: string;
  approvedAt: number;
  expiresAt: number;
};

export type ToolApprovalDecision = {
  allowed: boolean;
  code: "read_only" | "approval_required" | "approval_expired" | "approval_mismatch" | "approved";
  message: string;
};

export type ToolApprovalPrompt = {
  toolName: string;
  sideEffect: Exclude<ToolSideEffect, "read_only">;
  promptText: string;
  expiresAt: number;
};

export type ToolApprovalAuditRecord = {
  toolName: string;
  sideEffect: ToolSideEffect;
  allowed: boolean;
  decisionCode: ToolApprovalDecision["code"];
  requestedAt: number;
  decidedAt: number;
  approvedByUserId?: string;
  reason?: string;
};

const SIDE_EFFECT_LABELS: Record<Exclude<ToolSideEffect, "read_only">, string> = {
  local_write: "write local files",
  network: "make network calls",
  process_control: "control local processes",
  secret_adjacent: "read or touch sensitive local state",
};

export function requiresToolApproval(definition: ToolDefinition): boolean {
  return definition.sideEffect !== "read_only";
}

export function evaluateToolApproval(
  definition: ToolDefinition,
  approval: ToolApproval | undefined,
  now: number,
): ToolApprovalDecision {
  if (!requiresToolApproval(definition)) {
    return {
      allowed: true,
      code: "read_only",
      message: `Tool ${definition.name} is read-only.`,
    };
  }
  if (!approval) {
    return {
      allowed: false,
      code: "approval_required",
      message: `Tool ${definition.name} requires explicit approval before execution.`,
    };
  }
  if (approval.toolName !== definition.name) {
    return {
      allowed: false,
      code: "approval_mismatch",
      message: `Approval for ${approval.toolName} cannot be used for ${definition.name}.`,
    };
  }
  if (approval.expiresAt <= now) {
    return {
      allowed: false,
      code: "approval_expired",
      message: `Approval for ${definition.name} has expired.`,
    };
  }
  return {
    allowed: true,
    code: "approved",
    message: `Tool ${definition.name} was approved by ${approval.approvedByUserId}.`,
  };
}

export function buildToolApprovalPrompt(
  definition: ToolDefinition,
  now: number,
  ttlMs = 5 * 60 * 1000,
): ToolApprovalPrompt | undefined {
  const sideEffect = definition.sideEffect;
  if (sideEffect === "read_only") {
    return undefined;
  }
  return {
    toolName: definition.name,
    sideEffect,
    promptText: `Approve ${definition.name} to ${SIDE_EFFECT_LABELS[sideEffect]}? Approval expires in ${Math.round(
      ttlMs / 1000,
    )} seconds.`,
    expiresAt: now + ttlMs,
  };
}

export function buildToolApprovalAuditRecord(params: {
  definition: ToolDefinition;
  decision: ToolApprovalDecision;
  requestedAt: number;
  decidedAt: number;
  approval?: ToolApproval;
}): ToolApprovalAuditRecord {
  return {
    toolName: params.definition.name,
    sideEffect: params.definition.sideEffect,
    allowed: params.decision.allowed,
    decisionCode: params.decision.code,
    requestedAt: params.requestedAt,
    decidedAt: params.decidedAt,
    ...(params.approval ? { approvedByUserId: params.approval.approvedByUserId } : {}),
    ...(params.approval?.reason ? { reason: params.approval.reason } : {}),
  };
}
