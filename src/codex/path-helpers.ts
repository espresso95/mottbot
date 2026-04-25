import os from "node:os";
import path from "node:path";

/** Resolves the current user's home directory or throws before path-dependent auth work continues. */
export function resolveRequiredHomeDir(): string {
  const homeDir = os.homedir();
  if (!homeDir) {
    throw new Error("Unable to resolve user home directory.");
  }
  return path.resolve(homeDir);
}
