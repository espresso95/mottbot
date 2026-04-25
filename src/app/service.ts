import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** launchd label used for the macOS Mottbot service. */
export const SERVICE_LABEL = "ai.mottbot.bot";

/** Filesystem paths used by the macOS launchd service and its logs. */
export type LaunchAgentPaths = {
  label: string;
  plistPath: string;
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
};

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Resolves the per-user LaunchAgent plist and log paths for a service label. */
export function launchAgentPaths(label = SERVICE_LABEL): LaunchAgentPaths {
  const home = os.homedir();
  const logDir = path.join(home, "Library", "Logs", "mottbot");
  return {
    label,
    plistPath: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    logDir,
    stdoutPath: path.join(logDir, "bot.out.log"),
    stderrPath: path.join(logDir, "bot.err.log"),
  };
}

/** Builds the launchd plist that starts Mottbot from the provided project root. */
export function buildLaunchAgentPlist(params: {
  label?: string;
  projectRoot: string;
  stdoutPath?: string;
  stderrPath?: string;
}): string {
  const label = params.label ?? SERVICE_LABEL;
  const paths = launchAgentPaths(label);
  const projectRoot = path.resolve(params.projectRoot);
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const command = `cd ${shellQuote(projectRoot)} && ${shellQuote(process.execPath)} ${shellQuote(tsxCli)} src/index.ts start`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectRoot)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(params.stdoutPath ?? paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(params.stderrPath ?? paths.stderrPath)}</string>
</dict>
</plist>
`;
}

function ensureDarwin(): void {
  if (process.platform !== "darwin") {
    throw new Error("Mottbot service commands currently support macOS launchd only.");
  }
}

function userDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Cannot resolve the current user id for launchctl.");
  }
  return `gui/${uid}`;
}

function serviceTarget(label = SERVICE_LABEL): string {
  return `${userDomain()}/${label}`;
}

function runLaunchctl(args: string[]): CommandResult {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ignoreMissingService(result: CommandResult): void {
  if (result.status === 0) {
    return;
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (/Could not find service|No such process|service is not loaded/i.test(combined)) {
    return;
  }
  throw new Error(combined.trim() || "launchctl command failed.");
}

/** Writes the LaunchAgent plist and creates the expected log directory. */
export function installLaunchAgent(projectRoot = process.cwd()): LaunchAgentPaths {
  ensureDarwin();
  const paths = launchAgentPaths();
  fs.mkdirSync(path.dirname(paths.plistPath), { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.writeFileSync(
    paths.plistPath,
    buildLaunchAgentPlist({
      projectRoot,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
    }),
    { mode: 0o644 },
  );
  return paths;
}

/** Stops the loaded LaunchAgent, treating an already-stopped service as success. */
export function stopLaunchAgent(): void {
  ensureDarwin();
  ignoreMissingService(runLaunchctl(["bootout", serviceTarget()]));
}

/** Installs and bootstraps the LaunchAgent for the current macOS GUI session. */
export function startLaunchAgent(projectRoot = process.cwd()): LaunchAgentPaths {
  const paths = installLaunchAgent(projectRoot);
  stopLaunchAgent();
  let bootstrap = runLaunchctl(["bootstrap", userDomain(), paths.plistPath]);
  if (bootstrap.status !== 0 && /Bootstrap failed: 5|Input\/output error/i.test(bootstrap.stderr)) {
    sleepMs(1_000);
    bootstrap = runLaunchctl(["bootstrap", userDomain(), paths.plistPath]);
  }
  if (bootstrap.status !== 0) {
    throw new Error(bootstrap.stderr.trim() || "launchctl bootstrap failed.");
  }
  const enable = runLaunchctl(["enable", serviceTarget()]);
  if (enable.status !== 0) {
    throw new Error(enable.stderr.trim() || "launchctl enable failed.");
  }
  return paths;
}

/** Stops and starts the LaunchAgent using the latest generated plist. */
export function restartLaunchAgent(projectRoot = process.cwd()): LaunchAgentPaths {
  stopLaunchAgent();
  return startLaunchAgent(projectRoot);
}

/** Stops the LaunchAgent and removes its plist while leaving logs in place. */
export function uninstallLaunchAgent(): LaunchAgentPaths {
  const paths = launchAgentPaths();
  stopLaunchAgent();
  if (fs.existsSync(paths.plistPath)) {
    fs.unlinkSync(paths.plistPath);
  }
  return paths;
}

/** Returns a concise launchctl status summary for operator-facing CLI output. */
export function serviceStatus(): string {
  ensureDarwin();
  const result = runLaunchctl(["print", serviceTarget()]);
  if (result.status !== 0) {
    return `Mottbot service is not loaded (${SERVICE_LABEL}).`;
  }
  const lines = result.stdout.split("\n");
  const interesting = lines.filter((line) => /state =|pid =|last exit code =|program =/.test(line)).slice(0, 8);
  return [`Mottbot service is loaded (${SERVICE_LABEL}).`, ...interesting].join("\n");
}

/** Dispatches the service CLI subcommand and returns a process-style exit code. */
export function runServiceCommand(args: string[], projectRoot = process.cwd()): number {
  const [command = "status", ...rest] = args;
  if (command === "install") {
    const paths = installLaunchAgent(projectRoot);
    process.stdout.write(`Installed ${SERVICE_LABEL}\nPlist: ${paths.plistPath}\nLogs: ${paths.logDir}\n`);
    if (rest.includes("--start")) {
      startLaunchAgent(projectRoot);
      process.stdout.write("Started service.\n");
    }
    return 0;
  }
  if (command === "start") {
    const paths = startLaunchAgent(projectRoot);
    process.stdout.write(`Started ${SERVICE_LABEL}\nLogs: ${paths.logDir}\n`);
    return 0;
  }
  if (command === "stop") {
    stopLaunchAgent();
    process.stdout.write(`Stopped ${SERVICE_LABEL}\n`);
    return 0;
  }
  if (command === "restart") {
    const paths = restartLaunchAgent(projectRoot);
    process.stdout.write(`Restarted ${SERVICE_LABEL}\nLogs: ${paths.logDir}\n`);
    return 0;
  }
  if (command === "uninstall") {
    const paths = uninstallLaunchAgent();
    process.stdout.write(`Uninstalled ${SERVICE_LABEL}\nRemoved: ${paths.plistPath}\n`);
    return 0;
  }
  if (command === "status") {
    process.stdout.write(`${serviceStatus()}\n`);
    return 0;
  }
  process.stderr.write("Usage: mottbot service install [--start] | start | stop | restart | status | uninstall\n");
  return 1;
}
