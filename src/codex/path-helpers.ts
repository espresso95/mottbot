import os from "node:os";
import path from "node:path";

export function resolveRequiredHomeDir(): string {
  const homeDir = os.homedir();
  if (!homeDir) {
    throw new Error("Unable to resolve user home directory.");
  }
  return path.resolve(homeDir);
}
