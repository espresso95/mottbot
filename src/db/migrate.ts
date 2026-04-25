import fs from "node:fs";
import crypto from "node:crypto";
import { type DatabaseClient } from "./client.js";

type Migration = {
  version: number;
  name: string;
  checksum: string;
  sql: string;
};

type MigrationRow = {
  version: number;
  name: string;
  checksum: string;
};

const MIGRATION_FILE_PATTERN = /^(\d+)_(.+)\.sql$/;

function resolveMigrationsDir(): URL {
  const primary = new URL("./migrations/", import.meta.url);
  const fallback = new URL("../../src/db/migrations/", import.meta.url);
  return fs.existsSync(primary) ? primary : fallback;
}

function checksum(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function loadMigrations(): Migration[] {
  const migrationsDir = resolveMigrationsDir();
  return fs
    .readdirSync(migrationsDir)
    .flatMap((fileName): Migration[] => {
      const match = MIGRATION_FILE_PATTERN.exec(fileName);
      if (!match) {
        return [];
      }
      const rawVersion = match[1];
      const rawName = match[2];
      if (!rawVersion || !rawName) {
        return [];
      }
      const sql = fs.readFileSync(new URL(fileName, migrationsDir), "utf8");
      return [
        {
          version: Number(rawVersion),
          name: rawName.replaceAll("_", " "),
          checksum: checksum(sql),
          sql,
        },
      ];
    })
    .sort((a, b) => a.version - b.version);
}

function ensureMigrationLedger(database: DatabaseClient): void {
  database.db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at integer not null
    );
  `);
}

/** Applies pending SQL migrations and refuses to run if an applied migration changed. */
export function migrateDatabase(database: DatabaseClient): void {
  ensureMigrationLedger(database);
  const appliedRows = database.db
    .prepare<unknown[], MigrationRow>("select version, name, checksum from schema_migrations")
    .all();
  const applied = new Map(appliedRows.map((row) => [row.version, row]));
  const applyMigration = database.db.transaction((migration: Migration) => {
    const sql = migration.sql.trim();
    if (sql) {
      database.db.exec(sql);
    }
    database.db
      .prepare(
        `insert into schema_migrations (version, name, checksum, applied_at)
         values (?, ?, ?, ?)`,
      )
      .run(migration.version, migration.name, migration.checksum, Date.now());
  });

  for (const migration of loadMigrations()) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version} checksum mismatch. Refusing to continue with a modified migration.`,
        );
      }
      continue;
    }
    applyMigration(migration);
  }
}
