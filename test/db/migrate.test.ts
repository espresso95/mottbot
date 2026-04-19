import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

type CountRow = {
  count: number;
};

type NameRow = {
  name: string;
};

type MigrationRow = {
  version: number;
  name: string;
  checksum: string;
};

type ForeignKeyRow = {
  table: string;
  from: string;
};

function createDatabase(): { database: DatabaseClient; tempDir: string } {
  const tempDir = createTempDir();
  return {
    tempDir,
    database: new DatabaseClient(path.join(tempDir, "mottbot.sqlite")),
  };
}

function countRows(database: DatabaseClient, table: string): number {
  return database.db.prepare<unknown[], CountRow>(`select count(*) as count from ${table}`).get()?.count ?? 0;
}

describe("migrateDatabase", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  it("applies the initial migration to an empty database and is safe to rerun", () => {
    const { database, tempDir } = createDatabase();
    cleanup.push(() => {
      database.close();
      removeTempDir(tempDir);
    });

    migrateDatabase(database);

    expect(countRows(database, "schema_migrations")).toBe(1);
    expect(
      database.db
        .prepare<unknown[], NameRow>(
          "select name from sqlite_master where type = 'table' and name = 'run_queue'",
        )
        .get(),
    ).toEqual({ name: "run_queue" });

    migrateDatabase(database);

    const migrations = database.db
      .prepare<unknown[], MigrationRow>("select version, name, checksum from schema_migrations")
      .all();
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatchObject({ version: 1, name: "initial" });
  });

  it("bootstraps an unversioned database without dropping existing rows", () => {
    const { database, tempDir } = createDatabase();
    cleanup.push(() => {
      database.close();
      removeTempDir(tempDir);
    });
    database.db.exec(`
      create table session_routes (
        session_key text primary key,
        chat_id text not null,
        thread_id integer,
        user_id text,
        route_mode text not null,
        bound_name text,
        profile_id text not null,
        model_ref text not null,
        fast_mode integer not null default 0,
        system_prompt text,
        created_at integer not null,
        updated_at integer not null
      );

      create table runs (
        run_id text primary key,
        session_key text not null,
        status text not null,
        model_ref text not null,
        profile_id text not null,
        transport text,
        request_identity text,
        started_at integer,
        finished_at integer,
        error_code text,
        error_message text,
        usage_json text,
        created_at integer not null,
        updated_at integer not null,
        foreign key (session_key) references session_routes(session_key)
      );
    `);
    database.db
      .prepare(
        `insert into session_routes (
          session_key, chat_id, route_mode, profile_id, model_ref, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("tg:dm:1:user:1", "1", "dm", "openai-codex:default", "openai-codex/gpt-5.4", 100, 100);
    database.db
      .prepare(
        `insert into runs (
          run_id, session_key, status, model_ref, profile_id, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("run-1", "tg:dm:1:user:1", "completed", "openai-codex/gpt-5.4", "openai-codex:default", 100, 100);

    migrateDatabase(database);

    expect(countRows(database, "schema_migrations")).toBe(1);
    expect(countRows(database, "session_routes")).toBe(1);
    expect(countRows(database, "runs")).toBe(1);
    expect(
      database.db
        .prepare<unknown[], NameRow>(
          "select name from sqlite_master where type = 'table' and name = 'run_queue'",
        )
        .get(),
    ).toEqual({ name: "run_queue" });
  });

  it("creates queue indexes and foreign keys required by recovery", () => {
    const { database, tempDir } = createDatabase();
    cleanup.push(() => {
      database.close();
      removeTempDir(tempDir);
    });

    migrateDatabase(database);

    const indexNames = database.db
      .prepare<unknown[], NameRow>(
        "select name from sqlite_master where type = 'index' and tbl_name = 'run_queue'",
      )
      .all()
      .map((row) => row.name);
    expect(indexNames).toContain("idx_run_queue_state_updated");
    expect(indexNames).toContain("idx_run_queue_session_state");

    const foreignKeys = database.db
      .prepare<unknown[], ForeignKeyRow>("pragma foreign_key_list(run_queue)")
      .all();
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "run_id", table: "runs" }),
        expect.objectContaining({ from: "session_key", table: "session_routes" }),
      ]),
    );
  });

  it("fails clearly when an applied migration has a different checksum", () => {
    const { database, tempDir } = createDatabase();
    cleanup.push(() => {
      database.close();
      removeTempDir(tempDir);
    });
    migrateDatabase(database);
    database.db.prepare("update schema_migrations set checksum = ? where version = ?").run("bad-checksum", 1);

    expect(() => migrateDatabase(database)).toThrow(/checksum mismatch/i);
  });
});
