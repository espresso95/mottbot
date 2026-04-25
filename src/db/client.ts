import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { ensureParentDir } from "../shared/fs.js";

/** Thin SQLite client wrapper that applies the repo's required connection pragmas. */
export class DatabaseClient {
  readonly db: Database.Database;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      ensureParentDir(filePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (!fs.existsSync(filePath)) {
        const fd = fs.openSync(filePath, "a", 0o600);
        fs.closeSync(fd);
      }
      fs.chmodSync(filePath, 0o600);
    }
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    if (filePath !== ":memory:") {
      fs.chmodSync(filePath, 0o600);
      for (const sidecarPath of [`${filePath}-wal`, `${filePath}-shm`]) {
        if (fs.existsSync(sidecarPath)) {
          fs.chmodSync(sidecarPath, 0o600);
        }
      }
    }
  }

  close(): void {
    this.db.close();
  }
}
