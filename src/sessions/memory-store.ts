import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { SessionRoute, SessionRouteMode } from "./types.js";

/** Supported visibility scopes for approved long-term memories. */
const MEMORY_SCOPES = ["session", "personal", "chat", "group", "project"] as const;

/** Workflow states for model-proposed memory candidates. */
const MEMORY_CANDIDATE_STATUSES = ["pending", "accepted", "rejected", "archived"] as const;

/** Persisted approved memory that can be injected into future prompts. */
export type SessionMemory = {
  id: string;
  sessionKey: string;
  source: SessionMemorySource;
  scope: MemoryScope;
  scopeKey: string;
  contentText: string;
  pinned: boolean;
  archivedAt?: number;
  sourceCandidateId?: string;
  createdAt: number;
  updatedAt: number;
};

/** Origin of an approved memory entry. */
type SessionMemorySource = "explicit" | "auto_summary" | "model_candidate";

/** Memory visibility scope. */
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Candidate privacy sensitivity used for operator review. */
export type MemoryCandidateSensitivity = "low" | "medium" | "high";

/** Candidate review workflow state. */
export type MemoryCandidateStatus = (typeof MEMORY_CANDIDATE_STATUSES)[number];

/** Route fields needed to resolve memory scope keys for a session. */
export type MemoryScopeContext = Pick<SessionRoute, "sessionKey" | "chatId" | "threadId" | "userId" | "routeMode"> & {
  projectKey?: string;
};

/** Persisted model-proposed memory awaiting operator or user decision. */
export type MemoryCandidate = {
  id: string;
  sessionKey: string;
  scope: MemoryScope;
  scopeKey: string;
  contentText: string;
  reason?: string;
  sourceMessageIds: string[];
  sensitivity: MemoryCandidateSensitivity;
  status: MemoryCandidateStatus;
  proposedBy: string;
  decidedByUserId?: string;
  decidedAt?: number;
  acceptedMemoryId?: string;
  createdAt: number;
  updatedAt: number;
};

/** Result of attempting to insert a deduplicated memory candidate. */
type AddMemoryCandidateResult =
  | {
      inserted: true;
      candidate: MemoryCandidate;
    }
  | {
      inserted: false;
      reason: "duplicate_candidate" | "duplicate_memory";
      candidate?: MemoryCandidate;
    };

type SessionMemoryRow = {
  id: string;
  session_key: string;
  source: SessionMemorySource;
  scope: MemoryScope;
  scope_key: string;
  content_text: string;
  pinned: number;
  archived_at: number | null;
  source_candidate_id: string | null;
  created_at: number;
  updated_at: number;
};

type MemoryCandidateRow = {
  id: string;
  session_key: string;
  scope: MemoryScope;
  scope_key: string;
  content_text: string;
  reason: string | null;
  source_message_ids_json: string;
  sensitivity: MemoryCandidateSensitivity;
  status: MemoryCandidateStatus;
  proposed_by: string;
  decided_by_user_id: string | null;
  decided_at: number | null;
  accepted_memory_id: string | null;
  created_at: number;
  updated_at: number;
};

function mapMemoryRow(row: SessionMemoryRow): SessionMemory {
  return {
    id: row.id,
    sessionKey: row.session_key,
    source: row.source,
    scope: row.scope,
    scopeKey: row.scope_key,
    contentText: row.content_text,
    pinned: row.pinned === 1,
    ...(row.archived_at !== null ? { archivedAt: row.archived_at } : {}),
    ...(row.source_candidate_id ? { sourceCandidateId: row.source_candidate_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseSourceMessageIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function mapCandidateRow(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    sessionKey: row.session_key,
    scope: row.scope,
    scopeKey: row.scope_key,
    contentText: row.content_text,
    ...(row.reason ? { reason: row.reason } : {}),
    sourceMessageIds: parseSourceMessageIds(row.source_message_ids_json),
    sensitivity: row.sensitivity,
    status: row.status,
    proposedBy: row.proposed_by,
    ...(row.decided_by_user_id ? { decidedByUserId: row.decided_by_user_id } : {}),
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
    ...(row.accepted_memory_id ? { acceptedMemoryId: row.accepted_memory_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeMemoryText(value: string): string {
  const contentText = value.replace(/\s+/g, " ").trim();
  if (!contentText) {
    throw new Error("Memory text cannot be empty.");
  }
  if (contentText.length > 4_000) {
    throw new Error("Memory text must be 4000 characters or fewer.");
  }
  return contentText;
}

function normalizeOptionalReason(value: string | undefined): string | undefined {
  const reason = value?.replace(/\s+/g, " ").trim();
  if (!reason) {
    return undefined;
  }
  if (reason.length > 1_000) {
    throw new Error("Memory candidate reason must be 1000 characters or fewer.");
  }
  return reason;
}

function normalizeScopeKey(value: string): string {
  const scopeKey = value.replace(/\s+/g, " ").trim();
  if (!scopeKey) {
    throw new Error("Memory scope key cannot be empty.");
  }
  if (scopeKey.length > 200) {
    throw new Error("Memory scope key must be 200 characters or fewer.");
  }
  return scopeKey;
}

function normalizeIdPrefix(idPrefix: string): string {
  const normalized = idPrefix.trim();
  if (!normalized) {
    throw new Error("Memory id prefix cannot be empty.");
  }
  return `${normalized}%`;
}

function normalizedComparableText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function scopeRank(memory: SessionMemory): number {
  if (memory.source === "auto_summary") {
    return 90;
  }
  if (memory.pinned) {
    return 0;
  }
  switch (memory.scope) {
    case "project":
      return 10;
    case "personal":
      return 20;
    case "group":
      return 30;
    case "chat":
      return 40;
    case "session":
      return 50;
  }
}

function sortMemoriesForPrompt(memories: SessionMemory[]): SessionMemory[] {
  return [...memories].sort((left, right) => {
    const rank = scopeRank(left) - scopeRank(right);
    if (rank !== 0) {
      return rank;
    }
    if (left.updatedAt !== right.updatedAt) {
      return left.updatedAt - right.updatedAt;
    }
    return left.id.localeCompare(right.id);
  });
}

function scopeValues(context: MemoryScopeContext): Array<{ scope: MemoryScope; scopeKey: string }> {
  const values: Array<{ scope: MemoryScope; scopeKey: string }> = [
    { scope: "session", scopeKey: context.sessionKey },
    { scope: "chat", scopeKey: context.chatId },
  ];
  if (context.userId) {
    values.push({ scope: "personal", scopeKey: context.userId });
  }
  if (context.routeMode !== "dm") {
    values.push({ scope: "group", scopeKey: context.chatId });
  }
  if (context.projectKey) {
    values.push({ scope: "project", scopeKey: context.projectKey });
  }
  return values;
}

function routeModeAllowsGroupScope(routeMode: SessionRouteMode): boolean {
  return routeMode === "group" || routeMode === "topic" || routeMode === "bound";
}

/** Checks whether a string is a supported memory scope. */
export function isMemoryScope(value: string): value is MemoryScope {
  return MEMORY_SCOPES.includes(value as MemoryScope);
}

/** Checks whether a string is a supported memory-candidate status. */
export function isMemoryCandidateStatus(value: string): value is MemoryCandidateStatus {
  return MEMORY_CANDIDATE_STATUSES.includes(value as MemoryCandidateStatus);
}

/** Resolves the concrete key used to store or query a memory at the requested scope. */
export function resolveMemoryScopeKey(params: {
  context: MemoryScopeContext;
  scope: MemoryScope;
  explicitScopeKey?: string;
}): string | undefined {
  if (params.explicitScopeKey) {
    return normalizeScopeKey(params.explicitScopeKey);
  }
  switch (params.scope) {
    case "session":
      return params.context.sessionKey;
    case "personal":
      return params.context.userId;
    case "chat":
      return params.context.chatId;
    case "group":
      return routeModeAllowsGroupScope(params.context.routeMode) ? params.context.chatId : undefined;
    case "project":
      return params.context.projectKey;
  }
}

/** SQLite store for approved memories and model-proposed memory candidates. */
export class MemoryStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  add(params: {
    sessionKey: string;
    contentText: string;
    source?: SessionMemorySource;
    scope?: MemoryScope;
    scopeKey?: string;
    pinned?: boolean;
    sourceCandidateId?: string;
  }): SessionMemory {
    const contentText = normalizeMemoryText(params.contentText);
    const now = this.clock.now();
    const scope = params.scope ?? "session";
    const scopeKey = normalizeScopeKey(params.scopeKey ?? params.sessionKey);
    const memory: SessionMemory = {
      id: createId(),
      sessionKey: params.sessionKey,
      source: params.source ?? "explicit",
      scope,
      scopeKey,
      contentText,
      pinned: params.pinned === true,
      ...(params.sourceCandidateId ? { sourceCandidateId: params.sourceCandidateId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.database.db
      .prepare(
        `insert into session_memories (
          id, session_key, source, scope, scope_key, content_text, pinned, archived_at, source_candidate_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.sessionKey,
        memory.source,
        memory.scope,
        memory.scopeKey,
        memory.contentText,
        memory.pinned ? 1 : 0,
        memory.sourceCandidateId ?? null,
        memory.createdAt,
        memory.updatedAt,
      );
    return memory;
  }

  upsertAutoSummary(params: { sessionKey: string; contentText: string }): SessionMemory {
    const contentText = normalizeMemoryText(params.contentText);
    const now = this.clock.now();
    const current = this.database.db
      .prepare<unknown[], SessionMemoryRow>(
        `select *
         from session_memories
         where session_key = ? and source = 'auto_summary' and scope = 'session' and scope_key = ? and archived_at is null
         order by updated_at desc
         limit 1`,
      )
      .get(params.sessionKey, params.sessionKey);
    if (!current) {
      return this.add({ sessionKey: params.sessionKey, contentText, source: "auto_summary" });
    }
    this.database.db
      .prepare(
        `update session_memories
         set content_text = ?, updated_at = ?
         where id = ?`,
      )
      .run(contentText, now, current.id);
    return {
      ...mapMemoryRow(current),
      contentText,
      updatedAt: now,
    };
  }

  list(sessionKey: string, limit = 20, source?: SessionMemorySource): SessionMemory[] {
    if (source) {
      return this.database.db
        .prepare<unknown[], SessionMemoryRow>(
          `select *
           from session_memories
           where session_key = ? and source = ? and archived_at is null
           order by created_at desc
           limit ?`,
        )
        .all(sessionKey, source, limit)
        .reverse()
        .map(mapMemoryRow);
    }
    return this.database.db
      .prepare<unknown[], SessionMemoryRow>(
        `select *
         from session_memories
         where session_key = ? and archived_at is null
         order by created_at desc
         limit ?`,
      )
      .all(sessionKey, limit)
      .reverse()
      .map(mapMemoryRow);
  }

  listForScopeContext(context: MemoryScopeContext, limit = 50): SessionMemory[] {
    const rows = scopeValues(context);
    if (rows.length === 0) {
      return [];
    }
    const scopeClause = rows.map(() => "(scope = ? and scope_key = ?)").join(" or ");
    const values = rows.flatMap((row) => [row.scope, row.scopeKey]);
    const memories = this.database.db
      .prepare<unknown[], SessionMemoryRow>(
        `select *
         from session_memories
         where archived_at is null and (${scopeClause})
         order by updated_at desc
         limit ?`,
      )
      .all(...values, limit)
      .map(mapMemoryRow);
    return sortMemoriesForPrompt(memories);
  }

  update(sessionKey: string, idPrefix: string, contentText: string): SessionMemory | undefined {
    const normalizedText = normalizeMemoryText(contentText);
    const matches = this.database.db
      .prepare<unknown[], SessionMemoryRow>(
        `select *
         from session_memories
         where session_key = ? and id like ? and archived_at is null
         order by created_at desc
         limit 2`,
      )
      .all(sessionKey, normalizeIdPrefix(idPrefix));
    if (matches.length !== 1 || !matches[0]) {
      return undefined;
    }
    const now = this.clock.now();
    this.database.db
      .prepare(
        `update session_memories
         set content_text = ?, updated_at = ?
         where session_key = ? and id = ?`,
      )
      .run(normalizedText, now, sessionKey, matches[0].id);
    return {
      ...mapMemoryRow(matches[0]),
      contentText: normalizedText,
      updatedAt: now,
    };
  }

  remove(sessionKey: string, idPrefix: string): boolean {
    const matches = this.database.db
      .prepare<unknown[], { id: string }>(
        `select id
         from session_memories
         where session_key = ? and id like ? and archived_at is null
         order by created_at desc
         limit 2`,
      )
      .all(sessionKey, normalizeIdPrefix(idPrefix));
    if (matches.length !== 1 || !matches[0]) {
      return false;
    }
    return (
      this.database.db
        .prepare("delete from session_memories where session_key = ? and id = ?")
        .run(sessionKey, matches[0].id).changes > 0
    );
  }

  pinForScopeContext(context: MemoryScopeContext, idPrefix: string, pinned: boolean): SessionMemory | undefined {
    const memory = this.findMemoryByPrefixForScopeContext(context, idPrefix);
    if (!memory) {
      return undefined;
    }
    const now = this.clock.now();
    this.database.db
      .prepare(
        `update session_memories
         set pinned = ?, updated_at = ?
         where id = ?`,
      )
      .run(pinned ? 1 : 0, now, memory.id);
    return {
      ...memory,
      pinned,
      updatedAt: now,
    };
  }

  archiveForScopeContext(context: MemoryScopeContext, idPrefix: string): boolean {
    const memory = this.findMemoryByPrefixForScopeContext(context, idPrefix);
    if (!memory) {
      return false;
    }
    const now = this.clock.now();
    return (
      this.database.db
        .prepare(
          `update session_memories
           set archived_at = ?, updated_at = ?
           where id = ? and archived_at is null`,
        )
        .run(now, now, memory.id).changes > 0
    );
  }

  removeForScopeContext(context: MemoryScopeContext, idPrefix: string): boolean {
    const memory = this.findMemoryByPrefixForScopeContext(context, idPrefix);
    if (!memory) {
      return false;
    }
    return this.database.db.prepare("delete from session_memories where id = ?").run(memory.id).changes > 0;
  }

  clear(sessionKey: string, source?: SessionMemorySource): number {
    const whereClause = source ? "session_key = ? and source = ?" : "session_key = ?";
    const params = source ? [sessionKey, source] : [sessionKey];
    const detachCandidates = this.database.db.prepare(
      `update memory_candidates
       set accepted_memory_id = null
       where accepted_memory_id in (
         select id from session_memories where ${whereClause}
       )`,
    );
    const deleteMemories = this.database.db.prepare(`delete from session_memories where ${whereClause}`);
    const clear = this.database.db.transaction(() => {
      detachCandidates.run(...params);
      return deleteMemories.run(...params).changes;
    });
    return clear();
  }

  addCandidate(params: {
    sessionKey: string;
    scope: MemoryScope;
    scopeKey: string;
    contentText: string;
    reason?: string;
    sourceMessageIds?: string[];
    sensitivity: MemoryCandidateSensitivity;
    proposedBy?: string;
  }): AddMemoryCandidateResult {
    const contentText = normalizeMemoryText(params.contentText);
    const scopeKey = normalizeScopeKey(params.scopeKey);
    const duplicateCandidate = this.findDuplicateCandidate(params.scope, scopeKey, contentText);
    if (duplicateCandidate) {
      return { inserted: false, reason: "duplicate_candidate", candidate: duplicateCandidate };
    }
    if (this.hasDuplicateAcceptedMemory(params.scope, scopeKey, contentText)) {
      return { inserted: false, reason: "duplicate_memory" };
    }
    const now = this.clock.now();
    const reason = normalizeOptionalReason(params.reason);
    const candidate: MemoryCandidate = {
      id: createId(),
      sessionKey: params.sessionKey,
      scope: params.scope,
      scopeKey,
      contentText,
      ...(reason ? { reason } : {}),
      sourceMessageIds: [...new Set(params.sourceMessageIds ?? [])],
      sensitivity: params.sensitivity,
      status: "pending",
      proposedBy: params.proposedBy ?? "model",
      createdAt: now,
      updatedAt: now,
    };
    this.database.db
      .prepare(
        `insert into memory_candidates (
          id, session_key, scope, scope_key, content_text, reason, source_message_ids_json,
          sensitivity, status, proposed_by, decided_by_user_id, decided_at, accepted_memory_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, null, null, null, ?, ?)`,
      )
      .run(
        candidate.id,
        candidate.sessionKey,
        candidate.scope,
        candidate.scopeKey,
        candidate.contentText,
        candidate.reason ?? null,
        JSON.stringify(candidate.sourceMessageIds),
        candidate.sensitivity,
        candidate.proposedBy,
        candidate.createdAt,
        candidate.updatedAt,
      );
    return { inserted: true, candidate };
  }

  listCandidates(sessionKey: string, status: MemoryCandidateStatus | "all" = "pending", limit = 20): MemoryCandidate[] {
    if (status === "all") {
      return this.database.db
        .prepare<unknown[], MemoryCandidateRow>(
          `select *
           from memory_candidates
           where session_key = ?
           order by created_at desc
           limit ?`,
        )
        .all(sessionKey, limit)
        .reverse()
        .map(mapCandidateRow);
    }
    return this.database.db
      .prepare<unknown[], MemoryCandidateRow>(
        `select *
         from memory_candidates
         where session_key = ? and status = ?
         order by created_at desc
         limit ?`,
      )
      .all(sessionKey, status, limit)
      .reverse()
      .map(mapCandidateRow);
  }

  getCandidate(sessionKey: string, candidateId: string): MemoryCandidate | undefined {
    const row = this.database.db
      .prepare<unknown[], MemoryCandidateRow>(
        `select *
         from memory_candidates
         where session_key = ? and id = ?
         limit 1`,
      )
      .get(sessionKey, candidateId);
    return row ? mapCandidateRow(row) : undefined;
  }

  updateCandidate(sessionKey: string, idPrefix: string, contentText: string): MemoryCandidate | undefined {
    const candidate = this.findCandidateByPrefix(sessionKey, idPrefix, "pending");
    if (!candidate) {
      return undefined;
    }
    const normalizedText = normalizeMemoryText(contentText);
    const now = this.clock.now();
    this.database.db
      .prepare(
        `update memory_candidates
         set content_text = ?, updated_at = ?
         where id = ? and status = 'pending'`,
      )
      .run(normalizedText, now, candidate.id);
    return {
      ...candidate,
      contentText: normalizedText,
      updatedAt: now,
    };
  }

  acceptCandidate(params: {
    sessionKey: string;
    idPrefix: string;
    decidedByUserId?: string;
    pinned?: boolean;
  }): { candidate: MemoryCandidate; memory: SessionMemory } | undefined {
    const candidate = this.findCandidateByPrefix(params.sessionKey, params.idPrefix, "pending");
    if (!candidate) {
      return undefined;
    }
    const memory = this.add({
      sessionKey: candidate.sessionKey,
      contentText: candidate.contentText,
      source: "model_candidate",
      scope: candidate.scope,
      scopeKey: candidate.scopeKey,
      pinned: params.pinned,
      sourceCandidateId: candidate.id,
    });
    const now = this.clock.now();
    this.database.db
      .prepare(
        `update memory_candidates
         set status = 'accepted', decided_by_user_id = ?, decided_at = ?, accepted_memory_id = ?, updated_at = ?
         where id = ?`,
      )
      .run(params.decidedByUserId ?? null, now, memory.id, now, candidate.id);
    return {
      candidate: {
        ...candidate,
        status: "accepted",
        ...(params.decidedByUserId ? { decidedByUserId: params.decidedByUserId } : {}),
        decidedAt: now,
        acceptedMemoryId: memory.id,
        updatedAt: now,
      },
      memory,
    };
  }

  rejectCandidate(sessionKey: string, idPrefix: string, decidedByUserId?: string): boolean {
    return this.decideCandidate(sessionKey, idPrefix, "rejected", decidedByUserId);
  }

  archiveCandidate(sessionKey: string, idPrefix: string, decidedByUserId?: string): boolean {
    return this.decideCandidate(sessionKey, idPrefix, "archived", decidedByUserId);
  }

  clearCandidates(sessionKey: string, status: MemoryCandidateStatus = "pending"): number {
    return this.database.db
      .prepare("delete from memory_candidates where session_key = ? and status = ?")
      .run(sessionKey, status).changes;
  }

  private findMemoryByPrefixForScopeContext(context: MemoryScopeContext, idPrefix: string): SessionMemory | undefined {
    const scopes = scopeValues(context);
    if (scopes.length === 0) {
      return undefined;
    }
    const scopeClause = scopes.map(() => "(scope = ? and scope_key = ?)").join(" or ");
    const values = scopes.flatMap((row) => [row.scope, row.scopeKey]);
    const matches = this.database.db
      .prepare<unknown[], SessionMemoryRow>(
        `select *
         from session_memories
         where id like ? and archived_at is null and (${scopeClause})
         order by created_at desc
         limit 2`,
      )
      .all(normalizeIdPrefix(idPrefix), ...values)
      .map(mapMemoryRow);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private findCandidateByPrefix(
    sessionKey: string,
    idPrefix: string,
    status?: MemoryCandidateStatus,
  ): MemoryCandidate | undefined {
    const statusClause = status ? "and status = ?" : "";
    const params: unknown[] = [sessionKey, normalizeIdPrefix(idPrefix)];
    if (status) {
      params.push(status);
    }
    const matches = this.database.db
      .prepare<unknown[], MemoryCandidateRow>(
        `select *
         from memory_candidates
         where session_key = ? and id like ? ${statusClause}
         order by created_at desc
         limit 2`,
      )
      .all(...params)
      .map(mapCandidateRow);
    return matches.length === 1 ? matches[0] : undefined;
  }

  private decideCandidate(
    sessionKey: string,
    idPrefix: string,
    status: "rejected" | "archived",
    decidedByUserId?: string,
  ): boolean {
    const candidate = this.findCandidateByPrefix(sessionKey, idPrefix, "pending");
    if (!candidate) {
      return false;
    }
    const now = this.clock.now();
    return (
      this.database.db
        .prepare(
          `update memory_candidates
           set status = ?, decided_by_user_id = ?, decided_at = ?, updated_at = ?
           where id = ? and status = 'pending'`,
        )
        .run(status, decidedByUserId ?? null, now, now, candidate.id).changes > 0
    );
  }

  private findDuplicateCandidate(
    scope: MemoryScope,
    scopeKey: string,
    contentText: string,
  ): MemoryCandidate | undefined {
    const target = normalizedComparableText(contentText);
    return this.database.db
      .prepare<unknown[], MemoryCandidateRow>(
        `select *
         from memory_candidates
         where scope = ? and scope_key = ? and status = 'pending'
         order by created_at desc`,
      )
      .all(scope, scopeKey)
      .map(mapCandidateRow)
      .find((candidate) => normalizedComparableText(candidate.contentText) === target);
  }

  private hasDuplicateAcceptedMemory(scope: MemoryScope, scopeKey: string, contentText: string): boolean {
    const target = normalizedComparableText(contentText);
    return this.database.db
      .prepare<unknown[], SessionMemoryRow>(
        `select *
         from session_memories
         where scope = ? and scope_key = ? and archived_at is null`,
      )
      .all(scope, scopeKey)
      .map(mapMemoryRow)
      .some((memory) => normalizedComparableText(memory.contentText) === target);
  }
}
