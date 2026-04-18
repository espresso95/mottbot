import type { DatabaseClient } from "../db/client.js";
import { cosineSimilarity, createTextEmbedding } from "./memory-vectorizer.js";
import type { TranscriptMessageRole } from "./types.js";

type VectorRow = {
  message_id: string;
  role: TranscriptMessageRole;
  content_text: string;
  embedding_json: string;
  created_at: number;
};

export type RecalledMemory = {
  messageId: string;
  role: TranscriptMessageRole;
  contentText: string;
  score: number;
  createdAt: number;
};

function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is number => typeof value === "number");
  } catch {
    return [];
  }
}

export class VectorMemoryStore {
  constructor(private readonly database: DatabaseClient) {}

  indexMessage(params: {
    messageId: string;
    sessionKey: string;
    role: TranscriptMessageRole;
    contentText: string;
    createdAt: number;
  }): void {
    if (params.role === "tool") {
      return;
    }
    const contentText = params.contentText.trim();
    if (!contentText) {
      return;
    }
    const embedding = createTextEmbedding(contentText);
    if (embedding.length === 0) {
      return;
    }
    this.database.db
      .prepare(
        `insert into memory_vectors (
          message_id, session_key, role, content_text, embedding_json, created_at
        ) values (?, ?, ?, ?, ?, ?)
        on conflict(message_id) do update set
          role = excluded.role,
          content_text = excluded.content_text,
          embedding_json = excluded.embedding_json,
          created_at = excluded.created_at`,
      )
      .run(
        params.messageId,
        params.sessionKey,
        params.role,
        contentText,
        JSON.stringify(embedding),
        params.createdAt,
      );
  }

  search(params: {
    sessionKey: string;
    query: string;
    limit?: number;
    minScore?: number;
    excludeMessageIds?: string[];
  }): RecalledMemory[] {
    const queryEmbedding = createTextEmbedding(params.query);
    if (queryEmbedding.length === 0) {
      return [];
    }
    const candidateLimit = Math.max((params.limit ?? 4) * 8, 24);
    const rows = this.database.db
      .prepare<unknown[], VectorRow>(
        "select message_id, role, content_text, embedding_json, created_at from memory_vectors where session_key = ? order by created_at desc limit ?",
      )
      .all(params.sessionKey, candidateLimit);
    const excluded = new Set(params.excludeMessageIds ?? []);
    const minScore = params.minScore ?? 0.18;
    const ranked = rows
      .filter((row) => !excluded.has(row.message_id))
      .map((row): RecalledMemory | undefined => {
        const score = cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding_json));
        if (score < minScore) {
          return undefined;
        }
        return {
          messageId: row.message_id,
          role: row.role,
          contentText: row.content_text,
          score: Number(score.toFixed(4)),
          createdAt: row.created_at,
        };
      })
      .filter((entry): entry is RecalledMemory => Boolean(entry))
      .sort((a, b) => b.score - a.score || b.createdAt - a.createdAt);
    return ranked.slice(0, params.limit ?? 4);
  }

  clearSession(sessionKey: string): void {
    this.database.db.prepare("delete from memory_vectors where session_key = ?").run(sessionKey);
  }
}
