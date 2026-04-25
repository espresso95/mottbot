import fs from "node:fs";
import path from "node:path";
import type { LaunchAgentPaths } from "../app/service.js";
import { launchAgentPaths } from "../app/service.js";

/** Filesystem state for one launchd service log file. */
export type ServiceLogFileState = {
  role: "stdout" | "stderr";
  path: string;
  exists: boolean;
  sizeBytes: number;
  modifiedAt?: number;
  symlink: boolean;
};

/** Summary of the current service log directory and known log files. */
export type ServiceLogStatus = {
  logDir: string;
  files: ServiceLogFileState[];
};

/** Files archived, truncated, or skipped during a log rotation pass. */
export type ServiceLogRotationResult = {
  archiveDir: string;
  files: Array<{
    role: "stdout" | "stderr";
    sourcePath: string;
    archivedPath?: string;
    sizeBytes: number;
    truncated: boolean;
    skippedReason?: string;
  }>;
  removedArchives: string[];
};

function logFiles(paths: LaunchAgentPaths): Array<{ role: "stdout" | "stderr"; filePath: string }> {
  return [
    { role: "stdout", filePath: paths.stdoutPath },
    { role: "stderr", filePath: paths.stderrPath },
  ];
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

function stateFor(role: "stdout" | "stderr", filePath: string): ServiceLogFileState {
  if (!fs.existsSync(filePath)) {
    return {
      role,
      path: filePath,
      exists: false,
      sizeBytes: 0,
      symlink: false,
    };
  }
  const stats = fs.lstatSync(filePath);
  return {
    role,
    path: filePath,
    exists: true,
    sizeBytes: stats.isSymbolicLink() ? 0 : stats.size,
    ...(stats.isSymbolicLink() ? {} : { modifiedAt: stats.mtimeMs }),
    symlink: stats.isSymbolicLink(),
  };
}

/** Reads service log file state without modifying any log content. */
export function serviceLogStatus(paths: LaunchAgentPaths = launchAgentPaths()): ServiceLogStatus {
  return {
    logDir: paths.logDir,
    files: logFiles(paths).map((file) => stateFor(file.role, file.filePath)),
  };
}

function listArchiveDirs(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort();
}

/** Archives launchd logs, optionally truncates originals, and prunes old archives. */
export function rotateServiceLogs(
  params: {
    paths?: LaunchAgentPaths;
    archiveRoot?: string;
    truncate?: boolean;
    maxArchives?: number;
    now?: Date;
  } = {},
): ServiceLogRotationResult {
  const paths = params.paths ?? launchAgentPaths();
  const archiveRoot = path.resolve(params.archiveRoot ?? path.join(paths.logDir, "archive"));
  const archiveDir = path.join(archiveRoot, `logs-${timestampForPath(params.now)}`);
  fs.mkdirSync(archiveDir, { recursive: true });

  const files = logFiles(paths).map((file) => {
    const state = stateFor(file.role, file.filePath);
    if (!state.exists) {
      return {
        role: file.role,
        sourcePath: file.filePath,
        sizeBytes: 0,
        truncated: false,
        skippedReason: "missing",
      };
    }
    if (state.symlink) {
      return {
        role: file.role,
        sourcePath: file.filePath,
        sizeBytes: 0,
        truncated: false,
        skippedReason: "symlink",
      };
    }
    const archivedPath = path.join(archiveDir, path.basename(file.filePath));
    fs.copyFileSync(file.filePath, archivedPath);
    if (params.truncate === true) {
      fs.truncateSync(file.filePath, 0);
    }
    return {
      role: file.role,
      sourcePath: file.filePath,
      archivedPath,
      sizeBytes: state.sizeBytes,
      truncated: params.truncate === true,
    };
  });

  const removedArchives: string[] = [];
  const maxArchives = params.maxArchives;
  if (maxArchives !== undefined) {
    if (!Number.isInteger(maxArchives) || maxArchives < 1) {
      throw new Error("maxArchives must be a positive integer.");
    }
    const archiveDirs = listArchiveDirs(archiveRoot);
    const stale = archiveDirs.slice(0, Math.max(0, archiveDirs.length - maxArchives));
    for (const dir of stale) {
      fs.rmSync(dir, { recursive: true, force: true });
      removedArchives.push(dir);
    }
  }

  return {
    archiveDir,
    files,
    removedArchives,
  };
}
