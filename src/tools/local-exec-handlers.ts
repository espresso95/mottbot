import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ToolHandler } from "./executor.js";

/** Runtime allow-list and sandbox config for local execution tools. */
type LocalExecToolConfig = {
  roots: string[];
  deniedPaths: string[];
  allowedCommands: string[];
  timeoutMs: number;
  maxOutputBytes: number;
};

type LocalExecRoot = {
  label: string;
  originalPath: string;
  realPath: string;
};

type ResolvedExecCwd = {
  root: LocalExecRoot;
  realPath: string;
  displayPath: string;
};

const DEFAULT_DENIED_PATHS = [
  ".env",
  ".env.*",
  "mottbot.config.json",
  "auth.json",
  ".local",
  ".codex",
  ".git",
  "node_modules",
  "data",
  "dist",
  "coverage",
  "*.sqlite*",
  "*.sqlite3*",
  "*.db*",
  "*.log",
  "*.session*",
] as const;

const DENIED_COMMANDS = new Set(["bash", "sh", "zsh", "fish", "sudo", "su", "osascript", "open"]);
const MAX_ARGS = 40;
const MAX_ARG_BYTES = 2_000;
const SHELL_MARKERS = new Set(["shell", "mottbot:shell"]);
const CODE_MARKERS = new Set(["node", "mottbot:code"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeDisplayPath(value: string): string {
  return value.split(path.sep).join("/");
}

function decodePathInput(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function pathSegments(relativePath: string): string[] {
  return normalizeDisplayPath(relativePath).split("/").filter(Boolean);
}

function matchesDeniedPath(relativePath: string, spec: string): boolean {
  const normalizedRelative = normalizeDisplayPath(relativePath).replace(/^\.?\//, "");
  const normalizedSpec = normalizeDisplayPath(spec).replace(/^\.?\//, "");
  if (!normalizedRelative || !normalizedSpec) {
    return false;
  }
  if (!normalizedSpec.includes("/")) {
    return pathSegments(normalizedRelative).some((segment) => wildcardToRegExp(normalizedSpec).test(segment));
  }
  return (
    wildcardToRegExp(normalizedSpec).test(normalizedRelative) ||
    normalizedRelative.toLowerCase().startsWith(`${normalizedSpec.toLowerCase()}/`)
  );
}

function rootLabel(rootPath: string, realPath: string): string {
  const trimmed = rootPath.trim();
  if (trimmed && trimmed !== ".") {
    return path.basename(path.resolve(trimmed));
  }
  return path.basename(realPath) || realPath;
}

function commandBaseName(command: string): string {
  return path.basename(command.trim());
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
}

function limitBuffer(current: Buffer, next: Buffer, maxBytes: number): { buffer: Buffer; truncated: boolean } {
  const combined = Buffer.concat([current, next]);
  if (combined.byteLength <= maxBytes) {
    return { buffer: combined, truncated: false };
  }
  return { buffer: combined.subarray(0, maxBytes), truncated: true };
}

class LocalExecScope {
  private readonly roots: LocalExecRoot[];
  private readonly deniedPaths: string[];
  private readonly allowedCommands: Set<string>;

  constructor(config: LocalExecToolConfig) {
    this.deniedPaths = [...DEFAULT_DENIED_PATHS, ...config.deniedPaths];
    this.allowedCommands = new Set(config.allowedCommands.map((command) => command.trim()).filter(Boolean));
    this.roots = config.roots.map((rootPath) => {
      const absolutePath = path.resolve(rootPath);
      fs.mkdirSync(absolutePath, { recursive: true });
      const realPath = fs.realpathSync(absolutePath);
      const stats = fs.statSync(realPath);
      if (!stats.isDirectory()) {
        throw new Error(`Local exec root ${rootPath} is not a directory.`);
      }
      return {
        label: rootLabel(rootPath, realPath),
        originalPath: rootPath,
        realPath,
      };
    });
    if (this.roots.length === 0) {
      throw new Error("At least one local exec root must be configured.");
    }
  }

  resolveRoot(rootInput?: string): LocalExecRoot {
    const trimmed = rootInput?.trim();
    if (!trimmed) {
      if (this.roots.length === 1) {
        return this.roots[0]!;
      }
      throw new Error("Multiple local exec roots are configured; pass the root field.");
    }
    const decoded = decodePathInput(trimmed);
    const absoluteInput = path.resolve(decoded);
    const matches = this.roots.filter(
      (root) =>
        root.label === decoded ||
        root.originalPath === decoded ||
        root.realPath === decoded ||
        root.realPath === absoluteInput,
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1) {
      throw new Error(`Local exec root ${trimmed} is ambiguous.`);
    }
    throw new Error(`Local exec root ${trimmed} is not approved.`);
  }

  resolveCwd(params: { root?: string; cwd?: string }): ResolvedExecCwd {
    const root = this.resolveRoot(params.root);
    const cwd = params.cwd?.trim();
    if (!cwd) {
      return { root, realPath: root.realPath, displayPath: "." };
    }
    const decoded = decodePathInput(cwd);
    if (decoded.includes("\0")) {
      throw new Error("Local exec cwd contains a null byte.");
    }
    if (path.isAbsolute(decoded)) {
      throw new Error("Local exec cwd must be relative to an approved root.");
    }
    const candidate = path.resolve(root.realPath, decoded);
    if (!isInside(root.realPath, candidate)) {
      throw new Error(`Local exec cwd ${cwd} is outside the approved root.`);
    }
    const relativePath = path.relative(root.realPath, candidate);
    if (this.isDenied(relativePath)) {
      throw new Error(`Local exec cwd ${cwd} is denied by policy.`);
    }
    const realPath = fs.realpathSync(candidate);
    if (!isInside(root.realPath, realPath)) {
      throw new Error(`Local exec cwd ${cwd} resolves outside the approved root.`);
    }
    const realRelativePath = path.relative(root.realPath, realPath);
    if (this.isDenied(realRelativePath)) {
      throw new Error(`Local exec cwd ${cwd} is denied by policy.`);
    }
    const stats = fs.statSync(realPath);
    if (!stats.isDirectory()) {
      throw new Error(`Local exec cwd ${cwd} is not a directory.`);
    }
    return {
      root,
      realPath,
      displayPath: normalizeDisplayPath(realRelativePath) || ".",
    };
  }

  validateCommand(command: string): string {
    const trimmed = command.trim();
    if (!trimmed) {
      throw new Error("command is required.");
    }
    if (DENIED_COMMANDS.has(commandBaseName(trimmed))) {
      throw new Error(`Local command ${trimmed} is denied.`);
    }
    const allowlisted = commandHasPathSeparator(trimmed)
      ? this.allowedCommands.has(trimmed)
      : this.allowedCommands.has(trimmed) || this.allowedCommands.has(commandBaseName(trimmed));
    if (!allowlisted) {
      throw new Error(`Local command ${trimmed} is not allowlisted.`);
    }
    return trimmed;
  }

  validateShellAllowed(): string {
    if (![...SHELL_MARKERS].some((marker) => this.allowedCommands.has(marker))) {
      throw new Error("Local shell execution requires tools.localExec.allowedCommands to include shell.");
    }
    return process.env.SHELL || "/bin/zsh";
  }

  validateCodeExecutionAllowed(): string {
    if (
      ![...CODE_MARKERS].some((marker) => this.allowedCommands.has(marker)) &&
      !this.allowedCommands.has(process.execPath)
    ) {
      throw new Error("Local code execution requires tools.localExec.allowedCommands to include node.");
    }
    return process.execPath;
  }

  isDenied(relativePath: string): boolean {
    return this.deniedPaths.some((spec) => matchesDeniedPath(relativePath, spec));
  }
}

function normalizeArgs(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("args must be an array.");
  }
  if (value.length > MAX_ARGS) {
    throw new Error(`args must contain at most ${MAX_ARGS} entries.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`args[${index}] must be a string.`);
    }
    if (Buffer.byteLength(item, "utf8") > MAX_ARG_BYTES) {
      throw new Error(`args[${index}] exceeds ${MAX_ARG_BYTES} bytes.`);
    }
    if (item.includes("\0")) {
      throw new Error(`args[${index}] contains a null byte.`);
    }
    return item;
  });
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: ResolvedExecCwd;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stdin?: string;
}): Promise<{
  ok: boolean;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd.realPath,
      env: minimalEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin?.end(params.stdin ?? "");
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGTERM");
    }, params.timeoutMs);
    const abort = () => {
      truncated = true;
      child.kill("SIGTERM");
    };
    params.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      const limited = limitBuffer(stdout, chunk, params.maxOutputBytes);
      stdout = limited.buffer;
      truncated = truncated || limited.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const limited = limitBuffer(stderr, chunk, params.maxOutputBytes);
      stderr = limited.buffer;
      truncated = truncated || limited.truncated;
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", abort);
      resolve({
        ok: exitCode === 0,
        command: params.command,
        args: params.args,
        cwd: `${params.cwd.root.label}:${params.cwd.displayPath}`,
        exitCode,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated,
      });
    });
  });
}

/** Creates guarded local command execution handlers within configured roots. */
export function createLocalExecToolHandlers(config: LocalExecToolConfig): Partial<Record<string, ToolHandler>> {
  const scope = new LocalExecScope(config);
  return {
    mottbot_local_command_run: async ({ arguments: input, signal }) => {
      const command = scope.validateCommand(optionalString(input.command) ?? "");
      const cwd = scope.resolveCwd({
        root: optionalString(input.root),
        cwd: optionalString(input.cwd),
      });
      const requestedTimeout = typeof input.timeoutMs === "number" ? input.timeoutMs : config.timeoutMs;
      const timeoutMs = Math.min(requestedTimeout, config.timeoutMs);
      return await runCommand({
        command,
        cwd,
        args: normalizeArgs(input.args),
        timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal,
      });
    },
    mottbot_local_shell_run: async ({ arguments: input, signal }) => {
      const script = optionalString(input.script);
      if (!script) {
        throw new Error("script is required.");
      }
      const shell = scope.validateShellAllowed();
      const cwd = scope.resolveCwd({
        root: optionalString(input.root),
        cwd: optionalString(input.cwd),
      });
      const requestedTimeout = typeof input.timeoutMs === "number" ? input.timeoutMs : config.timeoutMs;
      const timeoutMs = Math.min(requestedTimeout, config.timeoutMs);
      return await runCommand({
        command: shell,
        cwd,
        args: ["-lc", script],
        timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal,
      });
    },
    mottbot_code_execution_run: async ({ arguments: input, signal }) => {
      const code = optionalString(input.code);
      if (!code) {
        throw new Error("code is required.");
      }
      const node = scope.validateCodeExecutionAllowed();
      const cwd = scope.resolveCwd({
        root: optionalString(input.root),
        cwd: optionalString(input.cwd),
      });
      const requestedTimeout = typeof input.timeoutMs === "number" ? input.timeoutMs : config.timeoutMs;
      const timeoutMs = Math.min(requestedTimeout, config.timeoutMs);
      return await runCommand({
        command: node,
        cwd,
        args: ["--input-type=module", "-"],
        stdin: code,
        timeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal,
      });
    },
  };
}
