#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normalizeServiceLabel } from "../../src/app/service-label.js";
import { parseCliArgs, pushStringFlag, stringFlag } from "./cli-args.js";
import { normalizeBotUsername } from "./telegram-user-smoke-helpers.js";

export type SmokeLaneAction =
  | "doctor"
  | "suite"
  | "preflight"
  | "telegram-user"
  | "service-status"
  | "service-start"
  | "service-restart"
  | "service-stop";

export type SmokeLaneConfig = {
  configPath: string;
  lane?: string;
  serviceLabel?: string;
  botUsername?: string;
  sessionPath?: string;
};

export type SmokeLaneInvocation = {
  command: "corepack";
  args: string[];
  env: Record<string, string>;
  action: SmokeLaneAction;
  config: SmokeLaneConfig;
};

export type SmokeLaneDoctorCheck = {
  name: string;
  status: "passed" | "failed" | "warning";
  message: string;
  details?: Record<string, string | number | boolean | string[]>;
};

export type SmokeLaneDoctorReport = {
  status: "passed" | "failed";
  configPath: string;
  lane?: string;
  checks: SmokeLaneDoctorCheck[];
  summary: {
    passed: number;
    failed: number;
    warnings: number;
  };
};

const LANE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANE_FLAGS_WITH_VALUES = new Set(["lane", "config-path", "action"]);
const ACTIONS = new Set<SmokeLaneAction>([
  "doctor",
  "suite",
  "preflight",
  "telegram-user",
  "service-status",
  "service-start",
  "service-restart",
  "service-stop",
]);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function resolveFrom(cwd: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
}

function defaultLaneConfigPath(cwd: string, lane: string): string {
  return path.resolve(cwd, ".local", "smoke-lanes", `${lane}.json`);
}

function parseLaneName(value: string | undefined): string | undefined {
  const lane = value?.trim();
  if (!lane) {
    return undefined;
  }
  if (!LANE_NAME_PATTERN.test(lane)) {
    throw new Error("--lane must contain only letters, numbers, dots, underscores, and hyphens.");
  }
  return lane;
}

function parseAction(value: string | undefined): SmokeLaneAction {
  const action = (value?.trim() || "suite") as SmokeLaneAction;
  if (!ACTIONS.has(action)) {
    throw new Error(`--action must be one of: ${[...ACTIONS].join(", ")}.`);
  }
  return action;
}

function readSmokeLaneConfig(configPath: string, lane: string | undefined, cwd: string): SmokeLaneConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Smoke lane config does not exist: ${configPath}`);
  }
  const raw = readSmokeLaneConfigObject(configPath);
  if (!raw) {
    throw new Error(`Smoke lane config must be a JSON object: ${configPath}`);
  }
  const service = asObject(raw.service);
  const smoke = asObject(raw.smoke);
  const serviceLabel = typeof service?.label === "string" ? normalizeServiceLabel(service.label) : undefined;
  const botUsername = typeof smoke?.botUsername === "string" ? normalizeBotUsername(smoke.botUsername) : undefined;
  const sessionPath =
    typeof smoke?.sessionPath === "string" && smoke.sessionPath.trim()
      ? resolveFrom(cwd, smoke.sessionPath.trim())
      : undefined;
  return {
    configPath,
    ...(lane ? { lane } : {}),
    ...(serviceLabel ? { serviceLabel } : {}),
    ...(botUsername ? { botUsername } : {}),
    ...(sessionPath ? { sessionPath } : {}),
  };
}

function readSmokeLaneConfigObject(configPath: string): Record<string, unknown> | undefined {
  return asObject(JSON.parse(fs.readFileSync(configPath, "utf8")));
}

function objectField(value: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  return asObject(value[name]);
}

function stringField(value: Record<string, unknown> | undefined, name: string): string | undefined {
  const raw = value?.[name];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function stringArrayField(value: Record<string, unknown> | undefined, name: string): string[] | undefined {
  const raw = value?.[name];
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const entries = raw
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return entries.length > 0 ? entries : undefined;
}

function numberField(value: Record<string, unknown> | undefined, name: string): number | undefined {
  const raw = value?.[name];
  return typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
}

function displayPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return absolutePath;
  }
  return `./${relative.split(path.sep).join("/")}`;
}

function containsLaneName(cwd: string, absolutePath: string, lane: string): boolean {
  return displayPath(cwd, absolutePath).toLowerCase().includes(lane.toLowerCase());
}

function pathCheck(params: {
  name: string;
  rawPath: string | undefined;
  lane: string | undefined;
  cwd: string;
}): SmokeLaneDoctorCheck {
  if (!params.rawPath) {
    return {
      name: params.name,
      status: "failed",
      message: "Path is not configured; the default would be shared across lanes.",
    };
  }
  const resolved = resolveFrom(params.cwd, params.rawPath);
  if (!params.lane) {
    return {
      name: params.name,
      status: "warning",
      message: "Path is configured, but lane-scoping cannot be checked without --lane.",
      details: { path: displayPath(params.cwd, resolved) },
    };
  }
  if (!containsLaneName(params.cwd, resolved, params.lane)) {
    return {
      name: params.name,
      status: "failed",
      message: "Path should include the lane name so parallel worktrees do not share state.",
      details: { path: displayPath(params.cwd, resolved), lane: params.lane },
    };
  }
  return {
    name: params.name,
    status: "passed",
    message: "Path is lane-scoped.",
    details: { path: displayPath(params.cwd, resolved) },
  };
}

type LaneSummary = {
  fileName: string;
  configPath: string;
  serviceLabel?: string;
  sqlitePath?: string;
  dashboardPort?: number;
  sessionPath?: string;
  botToken?: string;
};

type ComparableLaneField = "serviceLabel" | "sqlitePath" | "dashboardPort" | "sessionPath" | "botToken";

function laneSummary(configPath: string, raw: Record<string, unknown>, cwd: string): LaneSummary {
  const telegram = objectField(raw, "telegram");
  const storage = objectField(raw, "storage");
  const dashboard = objectField(raw, "dashboard");
  const service = objectField(raw, "service");
  const smoke = objectField(raw, "smoke");
  const serviceLabel = stringField(service, "label");
  const dashboardPort = numberField(dashboard, "port");
  const botToken = stringField(telegram, "botToken");
  const sqlitePath = stringField(storage, "sqlitePath");
  const sessionPath = stringField(smoke, "sessionPath");
  return {
    fileName: path.basename(configPath),
    configPath: path.resolve(configPath),
    ...(serviceLabel ? { serviceLabel: normalizeServiceLabel(serviceLabel) } : {}),
    ...(sqlitePath ? { sqlitePath: resolveFrom(cwd, sqlitePath) } : {}),
    ...(dashboardPort ? { dashboardPort } : {}),
    ...(sessionPath ? { sessionPath: resolveFrom(cwd, sessionPath) } : {}),
    ...(botToken ? { botToken } : {}),
  };
}

function siblingLaneSummaries(cwd: string, currentConfigPath: string): LaneSummary[] {
  const laneDir = path.resolve(cwd, ".local", "smoke-lanes");
  if (!fs.existsSync(laneDir)) {
    return [];
  }
  return fs
    .readdirSync(laneDir)
    .filter((entry) => entry.endsWith(".json"))
    .flatMap((entry): LaneSummary[] => {
      const configPath = path.join(laneDir, entry);
      if (path.resolve(configPath) === path.resolve(currentConfigPath)) {
        return [];
      }
      try {
        const raw = readSmokeLaneConfigObject(configPath);
        return raw ? [laneSummary(configPath, raw, cwd)] : [];
      } catch {
        return [];
      }
    });
}

function duplicateCheck(params: {
  name: string;
  field: ComparableLaneField;
  value: string | number | undefined;
  siblings: LaneSummary[];
}): SmokeLaneDoctorCheck {
  if (params.value === undefined) {
    return {
      name: params.name,
      status: "warning",
      message: "Uniqueness could not be checked because this value is not configured.",
    };
  }
  const duplicates = params.siblings
    .filter((sibling) => sibling[params.field] !== undefined && String(sibling[params.field]) === String(params.value))
    .map((sibling) => sibling.fileName);
  if (duplicates.length > 0) {
    return {
      name: params.name,
      status: "failed",
      message: "Value is shared with another local lane config.",
      details: { duplicates },
    };
  }
  return {
    name: params.name,
    status: "passed",
    message: "Value is unique among sibling lane configs.",
  };
}

/** Builds a token-free local validation report for a smoke lane config. */
export function createSmokeLaneDoctorReport(argv: readonly string[], cwd = process.cwd()): SmokeLaneDoctorReport {
  const args = parseCliArgs(argv);
  const lane = parseLaneName(stringFlag(args, "lane"));
  const configPathFlag = stringFlag(args, "config-path");
  if (!lane && !configPathFlag) {
    throw new Error("Pass --lane <name> or --config-path <file>.");
  }
  const configPath = configPathFlag ? resolveFrom(cwd, configPathFlag) : defaultLaneConfigPath(cwd, lane!);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Smoke lane config does not exist: ${configPath}`);
  }
  const raw = readSmokeLaneConfigObject(configPath);
  if (!raw) {
    throw new Error(`Smoke lane config must be a JSON object: ${configPath}`);
  }

  const telegram = objectField(raw, "telegram");
  const storage = objectField(raw, "storage");
  const attachments = objectField(raw, "attachments");
  const dashboard = objectField(raw, "dashboard");
  const service = objectField(raw, "service");
  const security = objectField(raw, "security");
  const projectTasks = objectField(raw, "projectTasks");
  const smoke = objectField(raw, "smoke");
  const rawServiceLabel = stringField(service, "label");
  const serviceLabel = rawServiceLabel ? normalizeServiceLabel(rawServiceLabel) : undefined;
  const sqlitePath = stringField(storage, "sqlitePath");
  const dashboardPort = numberField(dashboard, "port");
  const sessionPath = stringField(smoke, "sessionPath");
  const summary = laneSummary(configPath, raw, cwd);
  const siblings = siblingLaneSummaries(cwd, configPath);
  const mode = fs.statSync(configPath).mode & 0o777;
  const checks: SmokeLaneDoctorCheck[] = [
    {
      name: "config file permissions",
      status: (mode & 0o077) === 0 ? "passed" : "failed",
      message:
        (mode & 0o077) === 0
          ? "Config file is readable only by the owner."
          : "Config file contains secrets and should not be readable by group or others.",
      details: { mode: mode.toString(8) },
    },
    {
      name: "telegram bot token",
      status: stringField(telegram, "botToken") ? "passed" : "failed",
      message: stringField(telegram, "botToken") ? "Bot token is configured." : "telegram.botToken is required.",
    },
    {
      name: "admin user IDs",
      status: stringArrayField(telegram, "adminUserIds") ? "passed" : "failed",
      message: stringArrayField(telegram, "adminUserIds")
        ? "At least one admin user ID is configured."
        : "telegram.adminUserIds should include at least one operator user ID.",
    },
    {
      name: "master key",
      status: stringField(security, "masterKey") ? "passed" : "failed",
      message: stringField(security, "masterKey") ? "Master key is configured." : "security.masterKey is required.",
    },
    {
      name: "service label",
      status: serviceLabel ? "passed" : "failed",
      message: serviceLabel ? "Service label is configured." : "service.label should be set per lane.",
      ...(serviceLabel ? { details: { serviceLabel } } : {}),
    },
    {
      name: "dashboard port",
      status: dashboardPort ? "passed" : "failed",
      message: dashboardPort ? "Dashboard port is configured." : "dashboard.port should be set per lane.",
      ...(dashboardPort ? { details: { dashboardPort } } : {}),
    },
    {
      name: "smoke bot username",
      status: stringField(smoke, "botUsername") ? "passed" : "failed",
      message: stringField(smoke, "botUsername")
        ? "Smoke bot username is configured."
        : "smoke.botUsername is required for user-account smoke.",
    },
    pathCheck({ name: "sqlite path", rawPath: sqlitePath, lane, cwd }),
    pathCheck({ name: "attachment cache path", rawPath: stringField(attachments, "cacheDir"), lane, cwd }),
    pathCheck({ name: "project worktree path", rawPath: stringField(projectTasks, "worktreeRoot"), lane, cwd }),
    pathCheck({ name: "project artifact path", rawPath: stringField(projectTasks, "artifactRoot"), lane, cwd }),
    pathCheck({ name: "smoke user session path", rawPath: sessionPath, lane, cwd }),
    duplicateCheck({
      name: "sibling service label uniqueness",
      field: "serviceLabel",
      value: summary.serviceLabel,
      siblings,
    }),
    duplicateCheck({
      name: "sibling sqlite path uniqueness",
      field: "sqlitePath",
      value: summary.sqlitePath,
      siblings,
    }),
    duplicateCheck({
      name: "sibling dashboard port uniqueness",
      field: "dashboardPort",
      value: summary.dashboardPort,
      siblings,
    }),
    duplicateCheck({
      name: "sibling smoke session path uniqueness",
      field: "sessionPath",
      value: summary.sessionPath,
      siblings,
    }),
    duplicateCheck({
      name: "sibling bot token uniqueness",
      field: "botToken",
      value: summary.botToken,
      siblings,
    }),
  ];
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  return {
    status: failed > 0 ? "failed" : "passed",
    configPath,
    ...(lane ? { lane } : {}),
    checks,
    summary: {
      passed,
      failed,
      warnings,
    },
  };
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((item) => item === `--${name}` || item.startsWith(`--${name}=`) || item === `--no-${name}`);
}

function stripLaneFlags(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item) {
      continue;
    }
    if (!item.startsWith("--")) {
      result.push(item);
      continue;
    }
    const flag = item.slice("--".length).split("=")[0];
    if (!flag) {
      continue;
    }
    if (LANE_FLAGS_WITH_VALUES.has(flag)) {
      if (!item.includes("=")) {
        index += 1;
      }
      continue;
    }
    result.push(item);
  }
  return result;
}

function smokeArgs(config: SmokeLaneConfig, forwardedArgs: string[], requiresUserSmoke: boolean): string[] {
  const args: string[] = [];
  if (!hasFlag(forwardedArgs, "bot-username")) {
    if (!config.botUsername && requiresUserSmoke) {
      throw new Error("Lane config must include smoke.botUsername or pass --bot-username.");
    }
    pushStringFlag(args, "bot-username", config.botUsername);
  }
  if (!hasFlag(forwardedArgs, "session-path")) {
    if (!config.sessionPath && requiresUserSmoke) {
      throw new Error("Lane config must include smoke.sessionPath or pass --session-path.");
    }
    pushStringFlag(args, "session-path", config.sessionPath);
  }
  args.push(...forwardedArgs);
  return args;
}

function actionArgs(action: SmokeLaneAction, config: SmokeLaneConfig, forwardedArgs: string[]): string[] {
  if (action === "doctor") {
    throw new Error("--action doctor is handled directly by smoke:lane.");
  }
  if (action === "preflight") {
    return ["pnpm", "--silent", "smoke:preflight", ...forwardedArgs];
  }
  if (action === "telegram-user") {
    return ["pnpm", "--silent", "smoke:telegram-user", ...smokeArgs(config, forwardedArgs, true)];
  }
  if (action === "suite") {
    return ["pnpm", "--silent", "smoke:suite", ...smokeArgs(config, forwardedArgs, true)];
  }
  const serviceCommand = action.slice("service-".length);
  return ["pnpm", "--silent", "service", serviceCommand];
}

/** Builds the child process invocation for a lane-scoped smoke or service action. */
export function buildSmokeLaneInvocation(argv: readonly string[], cwd = process.cwd()): SmokeLaneInvocation {
  const args = parseCliArgs(argv);
  const lane = parseLaneName(stringFlag(args, "lane"));
  const configPathFlag = stringFlag(args, "config-path");
  if (!lane && !configPathFlag) {
    throw new Error("Pass --lane <name> or --config-path <file>.");
  }
  const configPath = configPathFlag ? resolveFrom(cwd, configPathFlag) : defaultLaneConfigPath(cwd, lane!);
  const config = readSmokeLaneConfig(configPath, lane, cwd);
  const action = parseAction(stringFlag(args, "action"));
  const forwardedArgs = stripLaneFlags(argv);
  return {
    command: "corepack",
    args: actionArgs(action, config, forwardedArgs),
    env: {
      MOTTBOT_CONFIG_PATH: config.configPath,
    },
    action,
    config,
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/* v8 ignore start */
function main(): void {
  const argv = process.argv.slice(2);
  const action = parseAction(stringFlag(parseCliArgs(argv), "action"));
  if (action === "doctor") {
    const report = createSmokeLaneDoctorReport(argv);
    printJson(report);
    process.exitCode = report.status === "passed" ? 0 : 1;
    return;
  }
  const invocation = buildSmokeLaneInvocation(argv);
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...invocation.env,
    },
  });
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printJson({ status: "failed", error: message });
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
