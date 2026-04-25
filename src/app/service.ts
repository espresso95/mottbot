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

/** Result from probing a candidate Node binary or launchd command. */
export type LaunchAgentCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
};

const SERVICE_NODE_PATH_ENV = "MOTTBOT_SERVICE_NODE_PATH";

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
  nodePath?: string;
  stdoutPath?: string;
  stderrPath?: string;
}): string {
  const label = params.label ?? SERVICE_LABEL;
  const paths = launchAgentPaths(label);
  const projectRoot = path.resolve(params.projectRoot);
  const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const nodePath = params.nodePath ?? process.execPath;
  const command = `cd ${shellQuote(projectRoot)} && ${shellQuote(nodePath)} ${shellQuote(tsxCli)} src/index.ts start`;
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

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function candidateFromPathEnv(env: NodeJS.ProcessEnv): string | undefined {
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, "node");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function fnmNodeCandidates(): string[] {
  const versionsRoot = path.join(os.homedir(), ".local", "share", "fnm", "node-versions");
  if (!fs.existsSync(versionsRoot)) {
    return [];
  }
  return fs
    .readdirSync(versionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map((version) => path.join(versionsRoot, version, "installation", "bin", "node"))
    .filter((candidate) => fs.existsSync(candidate));
}

function uniqueExistingCandidates(candidates: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of candidates) {
    if (!candidate?.trim()) {
      continue;
    }
    const expanded = expandHome(candidate.trim());
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
    if (!fs.existsSync(absolute)) {
      if (!seen.has(absolute)) {
        seen.add(absolute);
        result.push(absolute);
      }
      continue;
    }
    let key = absolute;
    try {
      key = fs.realpathSync(absolute);
    } catch {
      // Keep the absolute path for inaccessible candidates so diagnostics still show it.
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(absolute);
  }
  return result;
}

/** Returns candidate Node binaries for the LaunchAgent, honoring the explicit operator override first. */
export function launchAgentNodeCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env[SERVICE_NODE_PATH_ENV]?.trim();
  if (override) {
    return uniqueExistingCandidates([override]);
  }
  return uniqueExistingCandidates([process.execPath, candidateFromPathEnv(env), ...fnmNodeCandidates()]);
}

/** Probes whether a Node binary can start Mottbot's TypeScript service and load native SQLite bindings. */
export function probeLaunchAgentNode(nodePath: string, projectRoot: string): LaunchAgentCommandResult {
  const resolvedRoot = path.resolve(projectRoot);
  const script = `
const fs = require("node:fs");
const path = require("node:path");
const projectRoot = ${JSON.stringify(resolvedRoot)};
fs.accessSync(path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"));
const sqlitePath = require.resolve("better-sqlite3", { paths: [projectRoot] });
const Database = require(sqlitePath);
const db = new Database(":memory:");
db.prepare("select 1 as ok").get();
db.close();
process.stdout.write(JSON.stringify({
  execPath: process.execPath,
  nodeVersion: process.version,
  nodeModuleVersion: process.versions.modules
}));
`;
  const result = spawnSync(nodePath, ["-e", script], {
    cwd: resolvedRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? String(result.error?.message ?? ""),
  };
}

function summarizeProbeFailure(result: LaunchAgentCommandResult): string {
  const details = `${result.stderr}\n${result.stdout}`.trim();
  if (!details) {
    return `exit ${result.status}`;
  }
  return details.split("\n").slice(0, 4).join(" ");
}

/** Resolves the Node binary to embed in the LaunchAgent, rejecting candidates that cannot load SQLite. */
export function resolveLaunchAgentNodePath(projectRoot = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const candidates = launchAgentNodeCandidates(env);
  const failures: string[] = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      failures.push(`${candidate}: file does not exist`);
      continue;
    }
    const probe = probeLaunchAgentNode(candidate, projectRoot);
    if (probe.status === 0) {
      return candidate;
    }
    failures.push(`${candidate}: ${summarizeProbeFailure(probe)}`);
  }
  const override = env[SERVICE_NODE_PATH_ENV]?.trim();
  const hint = override
    ? `${SERVICE_NODE_PATH_ENV} is set but did not point to a usable Node binary.`
    : `Set ${SERVICE_NODE_PATH_ENV} to the Node binary used to install dependencies, then run corepack pnpm rebuild better-sqlite3.`;
  throw new Error(
    [
      `Could not find a Node binary that can start Mottbot from ${path.resolve(projectRoot)}.`,
      hint,
      "Candidates checked:",
      ...(failures.length > 0 ? failures.map((failure) => `- ${failure}`) : ["- none"]),
    ].join("\n"),
  );
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

function runLaunchctl(args: string[]): LaunchAgentCommandResult {
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

function ignoreMissingService(result: LaunchAgentCommandResult): void {
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
  const nodePath = resolveLaunchAgentNodePath(projectRoot);
  fs.mkdirSync(path.dirname(paths.plistPath), { recursive: true });
  fs.mkdirSync(paths.logDir, { recursive: true });
  fs.writeFileSync(
    paths.plistPath,
    buildLaunchAgentPlist({
      projectRoot,
      nodePath,
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
