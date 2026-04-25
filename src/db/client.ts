import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureParentDir } from "../shared/fs.js";

/** Thin SQLite client wrapper that applies the repo's required connection pragmas. */
export class DatabaseClient {
  readonly db: Database.Database;

  constructor(filePath: string) {
    ensureParentDir(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
  }

  close(): void {
    this.db.close();
  }
}
