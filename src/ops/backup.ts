import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AppConfig } from "../app/config.js";

/** Manifest entry for a file captured in an operational backup. */
export type BackupFileRecord = {
  role: "sqlite" | "sqlite-wal" | "sqlite-shm" | "config" | "env";
  path: string;
  sizeBytes: number;
  sha256: string;
};

/** On-disk manifest describing backup contents and secret-handling warnings. */
export type BackupManifest = {
  kind: "mottbot-backup";
  createdAt: string;
  sourceSqlitePath: string;
  envIncluded: boolean;
  warning?: string;
  files: BackupFileRecord[];
};

/** Result returned after creating and integrity-checking an operational backup. */
export type BackupResult = {
  backupDir: string;
  manifestPath: string;
  files: BackupFileRecord[];
  integrityCheck: string;
  envIncluded: boolean;
};

/** Validation report for an existing operational backup directory. */
export type BackupValidationResult = {
  backupDir: string;
  ok: boolean;
  manifestPath: string;
  integrityCheck?: string;
  errors: string[];
  warnings: string[];
};

const BACKUP_KIND = "mottbot-backup";

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

/** Builds the timestamped default backup directory name. */
export function defaultBackupName(date = new Date()): string {
  return `mottbot-backup-${timestampForPath(date)}`;
}

function ensureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function fileSha256(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function recordFile(role: BackupFileRecord["role"], baseDir: string, filePath: string): BackupFileRecord {
  const stats = fs.statSync(filePath);
  return {
    role,
    path: path.relative(baseDir, filePath),
    sizeBytes: stats.size,
    sha256: fileSha256(filePath),
  };
}

function sqliteIntegrityCheck(filePath: string): string {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare<unknown[], { integrity_check: string }>("pragma integrity_check").get();
    return row?.integrity_check ?? "missing integrity_check result";
  } finally {
    db.close();
  }
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactConfig);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /token|secret|password|masterKey|accessToken|refreshToken|authorization/i.test(key)
        ? "[redacted]"
        : redactConfig(entry),
    ]),
  );
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function copyIfPresent(params: {
  role: BackupFileRecord["role"];
  baseDir: string;
  sourcePath: string;
  destinationPath: string;
  files: BackupFileRecord[];
}): void {
  if (!fs.existsSync(params.sourcePath)) {
    return;
  }
  fs.copyFileSync(params.sourcePath, params.destinationPath);
  params.files.push(recordFile(params.role, params.baseDir, params.destinationPath));
}

/** Creates a SQLite-safe backup with a redacted config snapshot and optional env copy. */
export async function createOperationalBackup(params: {
  config: AppConfig;
  destinationRoot?: string;
  includeEnv?: boolean;
  now?: Date;
  envPath?: string;
}): Promise<BackupResult> {
  const sourceSqlitePath = path.resolve(params.config.storage.sqlitePath);
  if (!fs.existsSync(sourceSqlitePath)) {
    throw new Error(`SQLite database does not exist: ${sourceSqlitePath}`);
  }
  const destinationRoot = path.resolve(params.destinationRoot ?? path.join(process.cwd(), "data", "backups"));
  ensureDirectory(destinationRoot);
  const backupDir = path.join(destinationRoot, defaultBackupName(params.now));
  if (fs.existsSync(backupDir)) {
    throw new Error(`Backup destination already exists: ${backupDir}`);
  }
  ensureDirectory(backupDir);

  const files: BackupFileRecord[] = [];
  const sqliteBackupPath = path.join(backupDir, "mottbot.sqlite");
  const sourceDb = new Database(sourceSqlitePath, { readonly: true, fileMustExist: true });
  try {
    await sourceDb.backup(sqliteBackupPath);
  } finally {
    sourceDb.close();
  }
  const integrityCheck = sqliteIntegrityCheck(sqliteBackupPath);
  if (integrityCheck !== "ok") {
    throw new Error(`SQLite backup integrity check failed: ${integrityCheck}`);
  }
  files.push(recordFile("sqlite", backupDir, sqliteBackupPath));

  copyIfPresent({
    role: "sqlite-wal",
    baseDir: backupDir,
    sourcePath: `${sourceSqlitePath}-wal`,
    destinationPath: path.join(backupDir, "source.sqlite-wal"),
    files,
  });
  copyIfPresent({
    role: "sqlite-shm",
    baseDir: backupDir,
    sourcePath: `${sourceSqlitePath}-shm`,
    destinationPath: path.join(backupDir, "source.sqlite-shm"),
    files,
  });

  const configPath = path.join(backupDir, "config.redacted.json");
  writeJson(configPath, redactConfig(params.config));
  files.push(recordFile("config", backupDir, configPath));

  const envPath = path.resolve(params.envPath ?? path.join(process.cwd(), ".env"));
  if (params.includeEnv) {
    if (fs.existsSync(envPath)) {
      fs.copyFileSync(envPath, path.join(backupDir, ".env"));
      files.push(recordFile("env", backupDir, path.join(backupDir, ".env")));
    }
  }

  const manifest: BackupManifest = {
    kind: BACKUP_KIND,
    createdAt: (params.now ?? new Date()).toISOString(),
    sourceSqlitePath,
    envIncluded: params.includeEnv === true && files.some((file) => file.role === "env"),
    ...(params.includeEnv
      ? { warning: ".env was explicitly included and may contain secrets. Do not share this backup." }
      : {}),
    files,
  };
  const manifestPath = path.join(backupDir, "manifest.json");
  writeJson(manifestPath, manifest);

  return {
    backupDir,
    manifestPath,
    files,
    integrityCheck,
    envIncluded: manifest.envIncluded,
  };
}

function parseManifest(raw: string): BackupManifest {
  const parsed = JSON.parse(raw) as Partial<BackupManifest>;
  if (parsed.kind !== BACKUP_KIND || !Array.isArray(parsed.files)) {
    throw new Error("Invalid Mottbot backup manifest.");
  }
  return parsed as BackupManifest;
}

/** Validates manifest checksums, SQLite integrity, and restore warnings for a backup. */
export function validateOperationalBackup(params: {
  backupDir: string;
  targetSqlitePath?: string;
}): BackupValidationResult {
  const backupDir = path.resolve(params.backupDir);
  const manifestPath = path.join(backupDir, "manifest.json");
  const errors: string[] = [];
  const warnings: string[] = [];
  let integrityCheck: string | undefined;

  if (!fs.existsSync(manifestPath)) {
    return {
      backupDir,
      ok: false,
      manifestPath,
      errors: [`Missing manifest: ${manifestPath}`],
      warnings,
    };
  }

  let manifest: BackupManifest;
  try {
    manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      backupDir,
      ok: false,
      manifestPath,
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }

  for (const file of manifest.files) {
    const filePath = path.join(backupDir, file.path);
    if (!fs.existsSync(filePath)) {
      errors.push(`Missing backup file: ${file.path}`);
      continue;
    }
    const stats = fs.statSync(filePath);
    if (stats.size !== file.sizeBytes) {
      errors.push(`Size mismatch for ${file.path}: expected ${file.sizeBytes}, got ${stats.size}`);
    }
    const actualSha256 = fileSha256(filePath);
    if (actualSha256 !== file.sha256) {
      errors.push(`Checksum mismatch for ${file.path}`);
    }
  }

  const sqliteFile = manifest.files.find((file) => file.role === "sqlite");
  if (!sqliteFile) {
    errors.push("Manifest does not include a SQLite backup file.");
  } else {
    try {
      integrityCheck = sqliteIntegrityCheck(path.join(backupDir, sqliteFile.path));
      if (integrityCheck !== "ok") {
        errors.push(`SQLite integrity check failed: ${integrityCheck}`);
      }
    } catch (error) {
      errors.push(`SQLite integrity check could not run: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!manifest.envIncluded) {
    warnings.push(".env was not included. Restore requires recreating runtime secrets separately.");
  }
  if (params.targetSqlitePath && fs.existsSync(params.targetSqlitePath)) {
    warnings.push(
      `Restore target already exists and would need downtime plus an explicit replace: ${params.targetSqlitePath}`,
    );
  }

  return {
    backupDir,
    ok: errors.length === 0,
    manifestPath,
    ...(integrityCheck ? { integrityCheck } : {}),
    errors,
    warnings,
  };
}
