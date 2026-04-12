import fs from "node:fs";
import { DatabaseClient } from "./client.js";

export function migrateDatabase(database: DatabaseClient): void {
  const primarySchemaPath = new URL("./schema.sql", import.meta.url);
  const fallbackSchemaPath = new URL("../../src/db/schema.sql", import.meta.url);
  const schemaPath = fs.existsSync(primarySchemaPath) ? primarySchemaPath : fallbackSchemaPath;
  const schema = fs.readFileSync(schemaPath, "utf8");
  database.db.exec(schema);
}
