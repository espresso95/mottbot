import fs from "node:fs";
import path from "node:path";

/** Creates the parent directory for a file path when it does not already exist. */
export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Returns true only when the path exists and is a regular file. */
export function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
