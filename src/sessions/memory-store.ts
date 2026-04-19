import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";

export type SessionMemory = {
  id: string;
  sessionKey: string;
  contentText: string;
  createdAt: number;
  updatedAt: number;
};

type SessionMemoryRow = {
  id: string;
  session_key: string;
  content_text: string;
  created_at: number;
  updated_at: number;
};

function mapMemoryRow(row: SessionMemoryRow): SessionMemory {
  return {
    id: row.id,
    sessionKey: row.session_key,
    contentText: row.content_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  add(params: { sessionKey: string; contentText: string }): SessionMemory {
    const contentText = params.contentText.replace(/\s+/g, " ").trim();
    if (!contentText) {
      throw new Error("Memory text cannot be empty.");
    }
    if (contentText.length > 1_000) {
      throw new Error("Memory text must be 1000 characters or fewer.");
    }
    const now = this.clock.now();
    const memory: SessionMemory = {
      id: createId(),
      sessionKey: params.sessionKey,
      contentText,
      createdAt: now,
      updatedAt: now,
    };
    this.database.db
      .prepare(
        `insert into session_memories (
          id, session_key, content_text, created_at, updated_at
        ) values (?, ?, ?, ?, ?)`,
      )
      .run(memory.id, memory.sessionKey, memory.contentText, memory.createdAt, memory.updatedAt);
    return memory;
  }

  list(sessionKey: string, limit = 20): SessionMemory[] {
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

  clear(sessionKey: string): number {
    return this.database.db
      .prepare("delete from session_memories where session_key = ?")
      .run(sessionKey).changes;
  }
}
