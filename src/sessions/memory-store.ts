import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";

export type SessionMemory = {
  id: string;
  sessionKey: string;
  source: SessionMemorySource;
  contentText: string;
  createdAt: number;
  updatedAt: number;
};

export type SessionMemorySource = "explicit" | "auto_summary";

type SessionMemoryRow = {
  id: string;
  session_key: string;
  source: SessionMemorySource;
  content_text: string;
  created_at: number;
  updated_at: number;
};

function mapMemoryRow(row: SessionMemoryRow): SessionMemory {
  return {
    id: row.id,
    sessionKey: row.session_key,
    source: row.source,
    contentText: row.content_text,
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

export class MemoryStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  add(params: { sessionKey: string; contentText: string; source?: SessionMemorySource }): SessionMemory {
    const contentText = normalizeMemoryText(params.contentText);
    const now = this.clock.now();
    const memory: SessionMemory = {
      id: createId(),
      sessionKey: params.sessionKey,
      source: params.source ?? "explicit",
      contentText,
      createdAt: now,
      updatedAt: now,
    };
    this.database.db
      .prepare(
        `insert into session_memories (
          id, session_key, source, content_text, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?)`,
      )
      .run(memory.id, memory.sessionKey, memory.source, memory.contentText, memory.createdAt, memory.updatedAt);
    return memory;
  }

  upsertAutoSummary(params: { sessionKey: string; contentText: string }): SessionMemory {
    const contentText = normalizeMemoryText(params.contentText);
    const now = this.clock.now();
    const current = this.database.db
      .prepare<unknown[], SessionMemoryRow>(
        `select *
         from session_memories
         where session_key = ? and source = 'auto_summary'
         order by updated_at desc
         limit 1`,
      )
      .get(params.sessionKey);
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
           where session_key = ? and source = ?
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
         where session_key = ?
         order by created_at desc
         limit ?`,
      )
      .all(sessionKey, limit)
      .reverse()
      .map(mapMemoryRow);
  }

  remove(sessionKey: string, idPrefix: string): boolean {
    const matches = this.database.db
      .prepare<unknown[], { id: string }>(
        `select id
         from session_memories
         where session_key = ? and id like ?
         order by created_at desc
         limit 2`,
      )
      .all(sessionKey, `${idPrefix}%`);
    if (matches.length !== 1 || !matches[0]) {
      return false;
    }
    return (
      this.database.db
        .prepare("delete from session_memories where session_key = ? and id = ?")
        .run(sessionKey, matches[0].id).changes > 0
    );
  }

  clear(sessionKey: string, source?: SessionMemorySource): number {
    if (source) {
      return this.database.db
        .prepare("delete from session_memories where session_key = ? and source = ?")
        .run(sessionKey, source).changes;
    }
    return this.database.db.prepare("delete from session_memories where session_key = ?").run(sessionKey).changes;
  }
}
