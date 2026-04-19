import path from "node:path";
import { spawn } from "node:child_process";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export type ServiceRestartRequest = {
  reason: string;
  delayMs: number;
  projectRoot?: string;
};

export type ServiceRestartScheduled = {
  scheduled: true;
  delayMs: number;
  reason: string;
};

export type ServiceRestartSchedulerDeps = {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  execPath?: string;
};

export function scheduleServiceRestart(
  params: ServiceRestartRequest,
  deps: ServiceRestartSchedulerDeps = {},
): ServiceRestartScheduled {
  if ((deps.platform ?? process.platform) !== "darwin") {
    throw new Error("Service restart tool currently supports macOS launchd only.");
  }
  const projectRoot = path.resolve(params.projectRoot ?? process.cwd());
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const nodePath = deps.execPath ?? process.execPath;
  const delaySeconds = Math.max(1, Math.ceil(params.delayMs / 1000));
  const command = [
    `sleep ${delaySeconds}`,
    `cd ${shellQuote(projectRoot)}`,
    `${shellQuote(nodePath)} ${shellQuote(tsxCli)} src/index.ts service restart`,
  ].join(" && ");
  const child = (deps.spawn ?? spawn)("/bin/zsh", ["-lc", command], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return {
    scheduled: true,
    delayMs: delaySeconds * 1000,
    reason: params.reason,
  };
}
