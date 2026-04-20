import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { MemoryScope } from "../sessions/memory-store.js";
import type { ToolCallerRole } from "../tools/policy.js";
import type { NormalizedAttachment } from "./types.js";

export const TELEGRAM_USER_ROLES = ["owner", "admin", "trusted", "user"] as const;
export type TelegramUserRole = (typeof TELEGRAM_USER_ROLES)[number];

export type StoredTelegramUserRole = {
  userId: string;
  role: TelegramUserRole;
  source: "config" | "database";
  grantedByUserId?: string;
  reason?: string;
  createdAt: number;
  updatedAt: number;
};

export type ChatGovernancePolicy = {
  allowedRoles?: TelegramUserRole[];
  commandRoles?: Record<string, TelegramUserRole[]>;
  modelRefs?: string[];
  toolNames?: string[];
  memoryScopes?: MemoryScope[];
  attachmentMaxFileBytes?: number;
  attachmentMaxPerMessage?: number;
};

export type StoredChatGovernancePolicy = {
  chatId: string;
  policy: ChatGovernancePolicy;
  updatedByUserId?: string;
  createdAt: number;
  updatedAt: number;
};

export type GovernanceAuditRecord = {
  id: string;
  actorUserId?: string;
  targetUserId?: string;
  chatId?: string;
  action: "grant_role" | "revoke_role" | "set_chat_policy" | "clear_chat_policy";
  role?: TelegramUserRole;
  previousRole?: TelegramUserRole;
  policy?: ChatGovernancePolicy;
  reason?: string;
  createdAt: number;
};

export type ChatAttachmentPolicyViolation = {
  code: "attachment.too_many" | "attachment.too_large";
  message: string;
};

type RoleRow = {
  user_id: string;
  role: TelegramUserRole;
  granted_by_user_id: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
};

type ChatPolicyRow = {
  chat_id: string;
  policy_json: string;
  updated_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

type AuditRow = {
  id: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  chat_id: string | null;
  action: GovernanceAuditRecord["action"];
  role: TelegramUserRole | null;
  previous_role: TelegramUserRole | null;
  policy_json: string | null;
  reason: string | null;
  created_at: number;
};

function isRole(value: string): value is TelegramUserRole {
  return TELEGRAM_USER_ROLES.includes(value as TelegramUserRole);
}

export function parseTelegramUserRole(value: string | undefined): TelegramUserRole | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && isRole(normalized) ? normalized : undefined;
}

export function isGovernanceOperatorRole(role: TelegramUserRole): boolean {
  return role === "owner" || role === "admin";
}

function assertRoles(values: unknown, field: string): TelegramUserRole[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array of roles.`);
  }
  const roles = values.map((value) => {
    if (typeof value !== "string" || !isRole(value)) {
      throw new Error(`${field} contains an unknown role.`);
    }
    return value;
  });
  return [...new Set(roles)];
}

function assertStringList(values: unknown, field: string): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field} must contain non-empty strings.`);
    }
    return value.trim();
  });
}

function assertMemoryScopes(values: unknown): MemoryScope[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values)) {
    throw new Error("memoryScopes must be an array.");
  }
  const allowed = new Set(["session", "personal", "chat", "group", "project"]);
  return values.map((value) => {
    if (typeof value !== "string" || !allowed.has(value)) {
      throw new Error("memoryScopes contains an unknown scope.");
    }
    return value as MemoryScope;
  });
}

function assertPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

export function parseChatGovernancePolicy(raw: string): ChatGovernancePolicy {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Chat policy must be a JSON object.");
  }
  const allowedRoles = assertRoles(parsed.allowedRoles, "allowedRoles");
  const modelRefs = assertStringList(parsed.modelRefs, "modelRefs");
  const toolNames = assertStringList(parsed.toolNames, "toolNames");
  const memoryScopes = assertMemoryScopes(parsed.memoryScopes);
  const attachmentMaxFileBytes = assertPositiveInteger(
    parsed.attachmentMaxFileBytes,
    "attachmentMaxFileBytes",
  );
  const attachmentMaxPerMessage = assertPositiveInteger(
    parsed.attachmentMaxPerMessage,
    "attachmentMaxPerMessage",
  );
  const commandRolesRaw = parsed.commandRoles;
  let commandRoles: Record<string, TelegramUserRole[]> | undefined;
  if (commandRolesRaw !== undefined) {
    if (!commandRolesRaw || typeof commandRolesRaw !== "object" || Array.isArray(commandRolesRaw)) {
      throw new Error("commandRoles must be an object.");
    }
    commandRoles = Object.fromEntries(
      Object.entries(commandRolesRaw).map(([command, roles]) => {
        const normalizedCommand = command.trim().replace(/^\//, "").toLowerCase();
        if (!normalizedCommand) {
          throw new Error("commandRoles contains an empty command.");
        }
        return [normalizedCommand, assertRoles(roles, `commandRoles.${command}`) ?? []];
      }),
    );
  }
  return {
    ...(allowedRoles ? { allowedRoles } : {}),
    ...(commandRoles ? { commandRoles } : {}),
    ...(modelRefs ? { modelRefs } : {}),
    ...(toolNames ? { toolNames } : {}),
    ...(memoryScopes ? { memoryScopes } : {}),
    ...(attachmentMaxFileBytes ? { attachmentMaxFileBytes } : {}),
    ...(attachmentMaxPerMessage ? { attachmentMaxPerMessage } : {}),
  };
}

function mapRoleRow(row: RoleRow | undefined): StoredTelegramUserRole | undefined {
  if (!row) {
    return undefined;
  }
  return {
    userId: row.user_id,
    role: row.role,
    source: "database",
    ...(row.granted_by_user_id ? { grantedByUserId: row.granted_by_user_id } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPolicyRow(row: ChatPolicyRow | undefined): StoredChatGovernancePolicy | undefined {
  if (!row) {
    return undefined;
  }
  return {
    chatId: row.chat_id,
    policy: parseChatGovernancePolicy(row.policy_json),
    ...(row.updated_by_user_id ? { updatedByUserId: row.updated_by_user_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAuditRow(row: AuditRow | undefined): GovernanceAuditRecord | undefined {
  if (!row) {
    return undefined;
  }
  return {
    id: row.id,
    ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
    ...(row.target_user_id ? { targetUserId: row.target_user_id } : {}),
    ...(row.chat_id ? { chatId: row.chat_id } : {}),
    action: row.action,
    ...(row.role ? { role: row.role } : {}),
    ...(row.previous_role ? { previousRole: row.previous_role } : {}),
    ...(row.policy_json ? { policy: parseChatGovernancePolicy(row.policy_json) } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: row.created_at,
  };
}

export class TelegramGovernanceStore {
  private readonly ownerUserIds: Set<string>;

  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
    params: { ownerUserIds: string[] },
  ) {
    this.ownerUserIds = new Set(params.ownerUserIds.map((id) => id.trim()).filter(Boolean));
  }

  resolveUserRole(userId: string | undefined): TelegramUserRole {
    if (!userId) {
      return "user";
    }
    if (this.ownerUserIds.has(userId)) {
      return "owner";
    }
    return this.getStoredRole(userId)?.role ?? "user";
  }

  resolveToolCallerRole(userId: string | undefined): ToolCallerRole {
    return this.resolveUserRole(userId);
  }

  listRoles(): StoredTelegramUserRole[] {
    const rows = this.database.db
      .prepare<unknown[], RoleRow>("select * from telegram_user_roles order by role asc, user_id asc")
      .all()
      .map((row) => mapRoleRow(row)!)
      .filter((role) => !this.ownerUserIds.has(role.userId));
    const configOwners = [...this.ownerUserIds].sort().map((userId) => ({
      userId,
      role: "owner" as const,
      source: "config" as const,
      createdAt: 0,
      updatedAt: 0,
    }));
    return [...configOwners, ...rows];
  }

  getChatPolicy(chatId: string): StoredChatGovernancePolicy | undefined {
    const row = this.database.db
      .prepare<unknown[], ChatPolicyRow>("select * from telegram_chat_policies where chat_id = ?")
      .get(chatId);
    return mapPolicyRow(row);
  }

  setChatPolicy(params: {
    chatId: string;
    policy: ChatGovernancePolicy;
    actorUserId?: string;
    reason?: string;
  }): StoredChatGovernancePolicy {
    const now = this.clock.now();
    const policyJson = JSON.stringify(params.policy);
    const existing = this.getChatPolicy(params.chatId);
    this.database.db
      .prepare(
        `insert into telegram_chat_policies (chat_id, policy_json, updated_by_user_id, created_at, updated_at)
         values (?, ?, ?, ?, ?)
         on conflict(chat_id) do update set
           policy_json = excluded.policy_json,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at = excluded.updated_at`,
      )
      .run(params.chatId, policyJson, params.actorUserId ?? null, existing?.createdAt ?? now, now);
    this.recordAudit({
      action: "set_chat_policy",
      actorUserId: params.actorUserId,
      chatId: params.chatId,
      policy: params.policy,
      reason: params.reason,
    });
    return this.getChatPolicy(params.chatId)!;
  }

  clearChatPolicy(params: { chatId: string; actorUserId?: string; reason?: string }): boolean {
    const existing = this.getChatPolicy(params.chatId);
    const changed = this.database.db
      .prepare("delete from telegram_chat_policies where chat_id = ?")
      .run(params.chatId).changes > 0;
    if (changed) {
      this.recordAudit({
        action: "clear_chat_policy",
        actorUserId: params.actorUserId,
        chatId: params.chatId,
        policy: existing?.policy,
        reason: params.reason,
      });
    }
    return changed;
  }

  setUserRole(params: {
    userId: string;
    role: TelegramUserRole;
    actorUserId?: string;
    reason?: string;
  }): StoredTelegramUserRole | undefined {
    if (params.role === "user") {
      this.revokeUserRole(params);
      return undefined;
    }
    if (this.ownerUserIds.has(params.userId)) {
      throw new Error("Configured owner roles cannot be changed from Telegram.");
    }
    const previousRole = this.resolveUserRole(params.userId);
    if (previousRole === "owner" && params.role !== "owner") {
      this.assertAnotherOwner(params.userId);
    }
    const now = this.clock.now();
    this.database.db
      .prepare(
        `insert into telegram_user_roles (user_id, role, granted_by_user_id, reason, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(user_id) do update set
           role = excluded.role,
           granted_by_user_id = excluded.granted_by_user_id,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      )
      .run(params.userId, params.role, params.actorUserId ?? null, params.reason ?? null, now, now);
    this.recordAudit({
      action: "grant_role",
      actorUserId: params.actorUserId,
      targetUserId: params.userId,
      role: params.role,
      previousRole,
      reason: params.reason,
    });
    return this.getStoredRole(params.userId);
  }

  revokeUserRole(params: { userId: string; actorUserId?: string; reason?: string }): boolean {
    if (this.ownerUserIds.has(params.userId)) {
      throw new Error("Configured owner roles cannot be revoked from Telegram.");
    }
    const previousRole = this.resolveUserRole(params.userId);
    if (previousRole === "owner") {
      this.assertAnotherOwner(params.userId);
    }
    const changed = this.database.db
      .prepare("delete from telegram_user_roles where user_id = ?")
      .run(params.userId).changes > 0;
    if (changed) {
      this.recordAudit({
        action: "revoke_role",
        actorUserId: params.actorUserId,
        targetUserId: params.userId,
        previousRole,
        reason: params.reason,
      });
    }
    return changed;
  }

  isChatAllowed(params: { chatId: string; userId?: string }): boolean {
    const policy = this.getChatPolicy(params.chatId)?.policy;
    if (!policy?.allowedRoles || policy.allowedRoles.length === 0) {
      return true;
    }
    return policy.allowedRoles.includes(this.resolveUserRole(params.userId));
  }

  isCommandAllowed(params: { chatId: string; userId?: string; command: string }): boolean {
    const policy = this.getChatPolicy(params.chatId)?.policy;
    const command = params.command.replace(/^\//, "").toLowerCase();
    const allowedRoles = policy?.commandRoles?.[command] ?? policy?.commandRoles?.["*"];
    if (!allowedRoles || allowedRoles.length === 0) {
      return true;
    }
    return allowedRoles.includes(this.resolveUserRole(params.userId));
  }

  hasCommandPolicy(params: { chatId: string; command: string }): boolean {
    const policy = this.getChatPolicy(params.chatId)?.policy;
    const command = params.command.replace(/^\//, "").toLowerCase();
    return Boolean(policy?.commandRoles?.[command] || policy?.commandRoles?.["*"]);
  }

  isModelAllowed(params: { chatId: string; modelRef: string }): boolean {
    const modelRefs = this.getChatPolicy(params.chatId)?.policy.modelRefs;
    return !modelRefs || modelRefs.length === 0 || modelRefs.includes(params.modelRef);
  }

  isToolAllowed(params: { chatId: string; toolName: string }): boolean {
    const toolNames = this.getChatPolicy(params.chatId)?.policy.toolNames;
    return !toolNames || toolNames.length === 0 || toolNames.includes(params.toolName);
  }

  isMemoryScopeAllowed(params: { chatId: string; scope: MemoryScope }): boolean {
    const memoryScopes = this.getChatPolicy(params.chatId)?.policy.memoryScopes;
    return !memoryScopes || memoryScopes.length === 0 || memoryScopes.includes(params.scope);
  }

  validateAttachments(params: {
    chatId: string;
    attachments: readonly NormalizedAttachment[];
  }): ChatAttachmentPolicyViolation | undefined {
    const policy = this.getChatPolicy(params.chatId)?.policy;
    if (!policy) {
      return undefined;
    }
    if (
      typeof policy.attachmentMaxPerMessage === "number" &&
      params.attachments.length > policy.attachmentMaxPerMessage
    ) {
      return {
        code: "attachment.too_many",
        message: `Too many attachments for this chat. Maximum is ${policy.attachmentMaxPerMessage} per message.`,
      };
    }
    const maxFileBytes = policy.attachmentMaxFileBytes;
    if (typeof maxFileBytes === "number") {
      const oversized = params.attachments.find(
        (attachment) => typeof attachment.fileSize === "number" && attachment.fileSize > maxFileBytes,
      );
      if (oversized) {
        return {
          code: "attachment.too_large",
          message: `Attachment ${oversized.fileName ?? oversized.kind} exceeds this chat's size limit.`,
        };
      }
    }
    return undefined;
  }

  listAudit(limit = 10): GovernanceAuditRecord[] {
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    return this.database.db
      .prepare<unknown[], AuditRow>(
        `select * from telegram_governance_audit
         order by created_at desc
         limit ?`,
      )
      .all(boundedLimit)
      .map((row) => mapAuditRow(row)!)
      .filter(Boolean);
  }

  private getStoredRole(userId: string): StoredTelegramUserRole | undefined {
    const row = this.database.db
      .prepare<unknown[], RoleRow>("select * from telegram_user_roles where user_id = ?")
      .get(userId);
    return mapRoleRow(row);
  }

  private assertAnotherOwner(targetUserId: string): void {
    const ownerCount = new Set([
      ...this.ownerUserIds,
      ...this.database.db
        .prepare<unknown[], { user_id: string }>("select user_id from telegram_user_roles where role = 'owner'")
        .all()
        .map((row) => row.user_id),
    ]).size;
    if (ownerCount <= 1 && !this.ownerUserIds.has(targetUserId)) {
      throw new Error("Cannot remove the last owner role.");
    }
  }

  private recordAudit(params: {
    action: GovernanceAuditRecord["action"];
    actorUserId?: string;
    targetUserId?: string;
    chatId?: string;
    role?: TelegramUserRole;
    previousRole?: TelegramUserRole;
    policy?: ChatGovernancePolicy;
    reason?: string;
  }): GovernanceAuditRecord {
    const now = this.clock.now();
    const record: GovernanceAuditRecord = {
      id: createId(),
      ...(params.actorUserId ? { actorUserId: params.actorUserId } : {}),
      ...(params.targetUserId ? { targetUserId: params.targetUserId } : {}),
      ...(params.chatId ? { chatId: params.chatId } : {}),
      action: params.action,
      ...(params.role ? { role: params.role } : {}),
      ...(params.previousRole ? { previousRole: params.previousRole } : {}),
      ...(params.policy ? { policy: params.policy } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      createdAt: now,
    };
    this.database.db
      .prepare(
        `insert into telegram_governance_audit (
          id, actor_user_id, target_user_id, chat_id, action, role, previous_role, policy_json, reason, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.actorUserId ?? null,
        record.targetUserId ?? null,
        record.chatId ?? null,
        record.action,
        record.role ?? null,
        record.previousRole ?? null,
        record.policy ? JSON.stringify(record.policy) : null,
        record.reason ?? null,
        record.createdAt,
      );
    return record;
  }
}
