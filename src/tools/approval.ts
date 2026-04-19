import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { ToolDefinition, ToolSideEffect } from "./registry.js";

export type ToolApproval = {
  toolName: string;
  approvedByUserId: string;
  reason: string;
  approvedAt: number;
  expiresAt: number;
  requestFingerprint?: string;
  previewText?: string;
};

export type StoredToolApproval = ToolApproval & {
  id: string;
  sessionKey: string;
  consumedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type ToolApprovalDecision = {
  allowed: boolean;
  code:
    | "read_only"
    | "policy_allowed"
    | "policy_missing"
    | "role_denied"
    | "chat_denied"
    | "approval_required"
    | "approval_expired"
    | "approval_mismatch"
    | "approved"
    | "operator_approved"
    | "revoked";
  message: string;
};

export type ToolApprovalPrompt = {
  toolName: string;
  sideEffect: Exclude<ToolSideEffect, "read_only">;
  promptText: string;
  expiresAt: number;
};

export type ToolApprovalAuditRecord = {
  id?: string;
  sessionKey?: string;
  runId?: string;
  toolName: string;
  sideEffect: ToolSideEffect;
  allowed: boolean;
  decisionCode: ToolApprovalDecision["code"];
  requestedAt: number;
  decidedAt: number;
  approvedByUserId?: string;
  reason?: string;
  requestFingerprint?: string;
  previewText?: string;
  createdAt?: number;
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
  requestFingerprint?: string,
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
  if (
    approval.requestFingerprint &&
    requestFingerprint &&
    approval.requestFingerprint !== requestFingerprint
  ) {
    return {
      allowed: false,
      code: "approval_mismatch",
      message: `Approval for ${definition.name} was issued for a different request.`,
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
  sessionKey?: string;
  runId?: string;
  requestFingerprint?: string;
  previewText?: string;
}): ToolApprovalAuditRecord {
  return {
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    toolName: params.definition.name,
    sideEffect: params.definition.sideEffect,
    allowed: params.decision.allowed,
    decisionCode: params.decision.code,
    requestedAt: params.requestedAt,
    decidedAt: params.decidedAt,
    ...(params.approval ? { approvedByUserId: params.approval.approvedByUserId } : {}),
    ...(params.approval?.reason ? { reason: params.approval.reason } : {}),
    ...(params.requestFingerprint ?? params.approval?.requestFingerprint
      ? { requestFingerprint: params.requestFingerprint ?? params.approval?.requestFingerprint }
      : {}),
    ...(params.previewText ?? params.approval?.previewText
      ? { previewText: params.previewText ?? params.approval?.previewText }
      : {}),
  };
}

type ToolApprovalRow = {
  id: string;
  session_key: string;
  tool_name: string;
  approved_by_user_id: string;
  reason: string;
  approved_at: number;
  expires_at: number;
  request_fingerprint: string | null;
  preview_text: string | null;
  consumed_at: number | null;
  created_at: number;
  updated_at: number;
};

function mapApprovalRow(row: ToolApprovalRow | undefined): StoredToolApproval | undefined {
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    sessionKey: row.session_key,
    toolName: row.tool_name,
    approvedByUserId: row.approved_by_user_id,
    reason: row.reason,
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
    ...(row.request_fingerprint !== null ? { requestFingerprint: row.request_fingerprint } : {}),
    ...(row.preview_text !== null ? { previewText: row.preview_text } : {}),
    ...(row.consumed_at !== null ? { consumedAt: row.consumed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ToolApprovalStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  approve(params: {
    sessionKey: string;
    toolName: string;
    approvedByUserId: string;
    reason: string;
    ttlMs: number;
    requestFingerprint?: string;
    previewText?: string;
  }): StoredToolApproval {
    const now = this.clock.now();
    const approval: StoredToolApproval = {
      id: createId(),
      sessionKey: params.sessionKey,
      toolName: params.toolName,
      approvedByUserId: params.approvedByUserId,
      reason: params.reason.trim() || "operator approved",
      approvedAt: now,
      expiresAt: now + params.ttlMs,
      ...(params.requestFingerprint ? { requestFingerprint: params.requestFingerprint } : {}),
      ...(params.previewText ? { previewText: params.previewText } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.database.db
      .prepare(
        `insert into tool_approvals (
          id, session_key, tool_name, approved_by_user_id, reason, approved_at, expires_at, request_fingerprint, preview_text, consumed_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
      )
      .run(
        approval.id,
        approval.sessionKey,
        approval.toolName,
        approval.approvedByUserId,
        approval.reason,
        approval.approvedAt,
        approval.expiresAt,
        approval.requestFingerprint ?? null,
        approval.previewText ?? null,
        approval.createdAt,
        approval.updatedAt,
      );
    return approval;
  }

  findActive(params: { sessionKey: string; toolName: string; now?: number }): StoredToolApproval | undefined {
    const now = params.now ?? this.clock.now();
    const row = this.database.db
      .prepare<unknown[], ToolApprovalRow>(
        `select *
         from tool_approvals
         where session_key = ?
           and tool_name = ?
           and consumed_at is null
           and expires_at > ?
         order by expires_at desc
         limit 1`,
      )
      .get(params.sessionKey, params.toolName, now);
    return mapApprovalRow(row);
  }

  findLatestPendingRequest(params: {
    sessionKey: string;
    toolName: string;
  }): ToolApprovalAuditRecord | undefined {
    const row = this.database.db
      .prepare<unknown[], ToolApprovalAuditRow>(
        `select *
         from tool_approval_audit
         where session_key = ?
           and tool_name = ?
           and decision_code = 'approval_required'
           and request_fingerprint is not null
         order by requested_at desc, created_at desc
         limit 1`,
      )
      .get(params.sessionKey, params.toolName);
    return mapAuditRow(row);
  }

  listActive(sessionKey: string, now = this.clock.now()): StoredToolApproval[] {
    return this.database.db
      .prepare<unknown[], ToolApprovalRow>(
        `select *
         from tool_approvals
         where session_key = ?
           and consumed_at is null
           and expires_at > ?
         order by expires_at asc`,
      )
      .all(sessionKey, now)
      .map((row) => mapApprovalRow(row)!)
      .filter(Boolean);
  }

  listActiveAll(params: { limit?: number; now?: number } = {}): StoredToolApproval[] {
    const now = params.now ?? this.clock.now();
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
    return this.database.db
      .prepare<unknown[], ToolApprovalRow>(
        `select *
         from tool_approvals
         where consumed_at is null
           and expires_at > ?
         order by expires_at asc
         limit ?`,
      )
      .all(now, limit)
      .map((row) => mapApprovalRow(row)!)
      .filter(Boolean);
  }

  consume(id: string, now = this.clock.now()): boolean {
    return (
      this.database.db
        .prepare(
          `update tool_approvals
           set consumed_at = ?, updated_at = ?
           where id = ? and consumed_at is null`,
        )
        .run(now, now, id).changes > 0
    );
  }

  revokeActive(params: { sessionKey: string; toolName: string; now?: number }): number {
    const now = params.now ?? this.clock.now();
    return this.database.db
      .prepare(
        `update tool_approvals
         set consumed_at = ?, updated_at = ?
         where session_key = ?
           and tool_name = ?
           and consumed_at is null
           and expires_at > ?`,
      )
      .run(now, now, params.sessionKey, params.toolName, now).changes;
  }

  recordAudit(record: ToolApprovalAuditRecord): ToolApprovalAuditRecord {
    const now = this.clock.now();
    const id = record.id ?? createId();
    this.database.db
      .prepare(
        `insert into tool_approval_audit (
          id, session_key, run_id, tool_name, side_effect, allowed, decision_code, requested_at, decided_at, approved_by_user_id, reason, request_fingerprint, preview_text, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        record.sessionKey ?? null,
        record.runId ?? null,
        record.toolName,
        record.sideEffect,
        record.allowed ? 1 : 0,
        record.decisionCode,
        record.requestedAt,
        record.decidedAt,
        record.approvedByUserId ?? null,
        record.reason ?? null,
        record.requestFingerprint ?? null,
        record.previewText ?? null,
        record.createdAt ?? now,
      );
    return {
      ...record,
      id,
      createdAt: record.createdAt ?? now,
    };
  }

  listAudit(params: {
    sessionKey?: string;
    toolName?: string;
    decisionCode?: ToolApprovalDecision["code"];
    limit?: number;
  } = {}): ToolApprovalAuditRecord[] {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (params.sessionKey) {
      clauses.push("session_key = ?");
      values.push(params.sessionKey);
    }
    if (params.toolName) {
      clauses.push("tool_name = ?");
      values.push(params.toolName);
    }
    if (params.decisionCode) {
      clauses.push("decision_code = ?");
      values.push(params.decisionCode);
    }
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
    return this.database.db
      .prepare<unknown[], ToolApprovalAuditRow>(
        `select *
         from tool_approval_audit
         ${where}
         order by requested_at desc, created_at desc
         limit ?`,
      )
      .all(...values, limit)
      .map((row) => mapAuditRow(row)!)
      .filter(Boolean);
  }
}

type ToolApprovalAuditRow = {
  id: string;
  session_key: string | null;
  run_id: string | null;
  tool_name: string;
  side_effect: ToolSideEffect;
  allowed: number;
  decision_code: ToolApprovalDecision["code"];
  requested_at: number;
  decided_at: number;
  approved_by_user_id: string | null;
  reason: string | null;
  request_fingerprint: string | null;
  preview_text: string | null;
  created_at: number;
};

function mapAuditRow(row: ToolApprovalAuditRow | undefined): ToolApprovalAuditRecord | undefined {
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    toolName: row.tool_name,
    sideEffect: row.side_effect,
    allowed: row.allowed === 1,
    decisionCode: row.decision_code,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    ...(row.approved_by_user_id ? { approvedByUserId: row.approved_by_user_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.request_fingerprint ? { requestFingerprint: row.request_fingerprint } : {}),
    ...(row.preview_text ? { previewText: row.preview_text } : {}),
    createdAt: row.created_at,
  };
}
