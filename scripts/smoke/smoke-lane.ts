#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { normalizeServiceLabel } from "../../src/app/service-label.js";
import { parseCliArgs, pushStringFlag, stringFlag } from "./cli-args.js";
import { normalizeBotUsername } from "./telegram-user-smoke-helpers.js";

export type SmokeLaneAction =
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

const LANE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LANE_FLAGS_WITH_VALUES = new Set(["lane", "config-path", "action"]);
const ACTIONS = new Set<SmokeLaneAction>([
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
  const raw = asObject(JSON.parse(fs.readFileSync(configPath, "utf8")));
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
  const invocation = buildSmokeLaneInvocation(process.argv.slice(2));
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
