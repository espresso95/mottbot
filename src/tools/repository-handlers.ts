import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import type { ToolHandler } from "./executor.js";
import {
  createRepositoryScope,
  type RepositoryRoot,
  type RepositoryScope,
  type RepositoryToolConfig,
  type ResolvedRepositoryPath,
} from "./repository-scope.js";

const execFileAsync = promisify(execFile);
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 300;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 500;
const BINARY_SAMPLE_BYTES = 4096;

type ExecFileError = Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: string;
};

type RepositoryFileEntry = {
  path: string;
  type: "directory" | "file" | "symlink";
  size?: number;
};

type SearchMatch = {
  path: string;
  lineNumber: number;
  line: string;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function displayRoot(root: RepositoryRoot): string {
  return `${root.label}:${root.realPath}`;
}

function childDisplayPath(parent: ResolvedRepositoryPath, childName: string): string {
  if (parent.displayPath === ".") {
    return childName;
  }
  return `${parent.displayPath}/${childName}`;
}

function safeRelativePath(scope: RepositoryScope, root: RepositoryRoot, realPath: string): string | undefined {
  const relativePath = path.relative(root.realPath, realPath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath) ||
    scope.isDenied(relativePath)
  ) {
    return undefined;
  }
  return relativePath.split(path.sep).join("/") || ".";
}

function hasNullByte(filePath: string): boolean {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, BINARY_SAMPLE_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

function limitUtf8Bytes(text: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { text, bytes, truncated: false };
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const textWithSuffix = text.slice(0, low);
  return {
    text: textWithSuffix,
    bytes: Buffer.byteLength(textWithSuffix, "utf8"),
    truncated: true,
  };
}

function listFiles(params: {
  scope: RepositoryScope;
  target: ResolvedRepositoryPath;
  recursive: boolean;
  limit: number;
}): {
  root: string;
  path: string;
  entries: RepositoryFileEntry[];
  truncated: boolean;
  skippedDenied: number;
} {
  const stats = fs.statSync(params.target.realPath);
  if (!stats.isDirectory()) {
    throw new Error(`Repository path ${params.target.displayPath} is not a directory.`);
  }
  const entries: RepositoryFileEntry[] = [];
  let skippedDenied = 0;

  const walk = (directory: ResolvedRepositoryPath): void => {
    const children = fs
      .readdirSync(directory.realPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (entries.length >= params.limit) {
        return;
      }
      const relativeDisplay = childDisplayPath(directory, child.name);
      if (params.scope.isDenied(relativeDisplay)) {
        skippedDenied += 1;
        continue;
      }
      const childPath = path.join(directory.realPath, child.name);
      let realPath: string;
      try {
        realPath = fs.realpathSync(childPath);
      } catch {
        skippedDenied += 1;
        continue;
      }
      if (!safeRelativePath(params.scope, params.target.root, realPath)) {
        skippedDenied += 1;
        continue;
      }
      let childStats: fs.Stats;
      try {
        childStats = fs.statSync(realPath);
      } catch {
        skippedDenied += 1;
        continue;
      }
      const type: RepositoryFileEntry["type"] = child.isSymbolicLink()
        ? "symlink"
        : childStats.isDirectory()
          ? "directory"
          : "file";
      entries.push({
        path: relativeDisplay,
        type,
        ...(!childStats.isDirectory() ? { size: childStats.size } : {}),
      });
      if (params.recursive && childStats.isDirectory() && !child.isSymbolicLink() && entries.length < params.limit) {
        walk({
          root: params.target.root,
          absolutePath: childPath,
          realPath,
          relativePath: path.relative(params.target.root.realPath, realPath),
          displayPath: relativeDisplay,
        });
      }
    }
  };

  walk(params.target);
  return {
    root: displayRoot(params.target.root),
    path: params.target.displayPath,
    entries,
    truncated: entries.length >= params.limit,
    skippedDenied,
  };
}

async function readFileSlice(params: {
  target: ResolvedRepositoryPath;
  startLine: number;
  maxLines: number;
  maxBytes: number;
}): Promise<{
  root: string;
  path: string;
  startLine: number;
  endLine: number;
  bytes: number;
  truncated: boolean;
  text: string;
}> {
  const stats = fs.statSync(params.target.realPath);
  if (!stats.isFile()) {
    throw new Error(`Repository path ${params.target.displayPath} is not a regular file.`);
  }
  if (hasNullByte(params.target.realPath)) {
    throw new Error(`Repository path ${params.target.displayPath} appears to be binary.`);
  }

  const stream = fs.createReadStream(params.target.realPath, { encoding: "utf8" });
  const lines = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let endLine = params.startLine - 1;
  let text = "";
  let truncated = false;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber < params.startLine) {
        continue;
      }
      if (lineNumber >= params.startLine + params.maxLines) {
        truncated = true;
        break;
      }
      const nextText = `${text}${line}\n`;
      if (Buffer.byteLength(nextText, "utf8") > params.maxBytes) {
        truncated = true;
        text = limitUtf8Bytes(nextText, params.maxBytes).text;
        endLine = lineNumber;
        break;
      }
      text = nextText;
      endLine = lineNumber;
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  const limited = limitUtf8Bytes(text, params.maxBytes);
  return {
    root: displayRoot(params.target.root),
    path: params.target.displayPath,
    startLine: params.startLine,
    endLine,
    bytes: limited.bytes,
    truncated: truncated || limited.truncated,
    text: limited.text,
  };
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
}): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(params.command, params.args, {
      cwd: params.cwd,
      timeout: params.timeoutMs,
      maxBuffer: params.maxBuffer,
      encoding: "utf8",
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (caught) {
    const error = caught as ExecFileError;
    if (error.code === 1 && params.command === "rg") {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }
    throw new Error(error.stderr?.trim() || error.message, { cause: caught });
  }
}

function parseRgMatches(params: {
  scope: RepositoryScope;
  root: RepositoryRoot;
  output: string;
  maxMatches: number;
  maxBytes: number;
}): { matches: SearchMatch[]; truncated: boolean; bytes: number } {
  const matches: SearchMatch[] = [];
  let bytes = 0;
  let truncated = false;
  for (const line of params.output.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "match") {
      continue;
    }
    const data = (parsed as { data?: unknown }).data;
    if (!data || typeof data !== "object") {
      continue;
    }
    const pathText = (data as { path?: { text?: unknown } }).path?.text;
    const lineText = (data as { lines?: { text?: unknown } }).lines?.text;
    const lineNumber = (data as { line_number?: unknown }).line_number;
    if (typeof pathText !== "string" || typeof lineText !== "string" || typeof lineNumber !== "number") {
      continue;
    }
    let realPath: string;
    try {
      realPath = fs.realpathSync(path.resolve(params.root.realPath, pathText));
    } catch {
      continue;
    }
    const safePath = safeRelativePath(params.scope, params.root, realPath);
    if (!safePath) {
      continue;
    }
    const match: SearchMatch = {
      path: safePath,
      lineNumber,
      line: lineText.replace(/\r?\n$/, ""),
    };
    const nextBytes = bytes + Buffer.byteLength(JSON.stringify(match), "utf8");
    if (matches.length >= params.maxMatches || nextBytes > params.maxBytes) {
      truncated = true;
      break;
    }
    matches.push(match);
    bytes = nextBytes;
  }
  return { matches, truncated, bytes };
}

function collectSearchFiles(params: {
  scope: RepositoryScope;
  root: RepositoryRoot;
  directory: string;
  files: string[];
  maxFiles: number;
}): void {
  if (params.files.length >= params.maxFiles) {
    return;
  }
  const children = fs
    .readdirSync(params.directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (params.files.length >= params.maxFiles) {
      return;
    }
    const childPath = path.join(params.directory, child.name);
    let realPath: string;
    try {
      realPath = fs.realpathSync(childPath);
    } catch {
      continue;
    }
    const safePath = safeRelativePath(params.scope, params.root, realPath);
    if (!safePath) {
      continue;
    }
    const stats = fs.statSync(realPath);
    if (stats.isDirectory()) {
      if (child.isSymbolicLink()) {
        continue;
      }
      collectSearchFiles({
        ...params,
        directory: realPath,
      });
      continue;
    }
    if (stats.isFile()) {
      params.files.push(realPath);
    }
  }
}

function fallbackSearch(params: {
  scope: RepositoryScope;
  target: ResolvedRepositoryPath;
  query: string;
  maxMatches: number;
  maxBytes: number;
}): { matches: SearchMatch[]; truncated: boolean; bytes: number; engine: "node" } {
  const stats = fs.statSync(params.target.realPath);
  const files: string[] = [];
  if (stats.isFile()) {
    files.push(params.target.realPath);
  } else if (stats.isDirectory()) {
    collectSearchFiles({
      scope: params.scope,
      root: params.target.root,
      directory: params.target.realPath,
      files,
      maxFiles: 5_000,
    });
  }
  const matches: SearchMatch[] = [];
  let bytes = 0;
  let truncated = false;
  for (const filePath of files) {
    if (matches.length >= params.maxMatches || bytes >= params.maxBytes) {
      truncated = true;
      break;
    }
    if (hasNullByte(filePath)) {
      continue;
    }
    const safePath = safeRelativePath(params.scope, params.target.root, filePath);
    if (!safePath) {
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index]!.includes(params.query)) {
        continue;
      }
      const match = {
        path: safePath,
        lineNumber: index + 1,
        line: lines[index]!,
      };
      const nextBytes = bytes + Buffer.byteLength(JSON.stringify(match), "utf8");
      if (matches.length >= params.maxMatches || nextBytes > params.maxBytes) {
        truncated = true;
        break;
      }
      matches.push(match);
      bytes = nextBytes;
    }
  }
  return {
    matches,
    truncated,
    bytes,
    engine: "node",
  };
}

async function searchRepository(params: {
  scope: RepositoryScope;
  config: RepositoryToolConfig;
  target: ResolvedRepositoryPath;
  query: string;
  maxMatches: number;
  maxBytes: number;
}): Promise<{
  root: string;
  path: string;
  query: string;
  engine: "rg" | "node";
  matches: SearchMatch[];
  truncated: boolean;
  bytes: number;
}> {
  const rgArgs = [
    "--json",
    "--fixed-strings",
    "--color",
    "never",
    "--no-messages",
    ...params.scope.rgGlobs().flatMap((glob) => ["--glob", glob]),
    params.query,
    params.target.realPath,
  ];
  try {
    const output = await runCommand({
      command: "rg",
      args: rgArgs,
      cwd: params.target.root.realPath,
      timeoutMs: params.config.commandTimeoutMs,
      maxBuffer: Math.max(params.maxBytes * 4, 64_000),
    });
    return {
      root: displayRoot(params.target.root),
      path: params.target.displayPath,
      query: params.query,
      engine: "rg",
      ...parseRgMatches({
        scope: params.scope,
        root: params.target.root,
        output: output.stdout,
        maxMatches: params.maxMatches,
        maxBytes: params.maxBytes,
      }),
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (!/ENOENT|spawn rg/i.test(message)) {
      throw caught;
    }
    const fallback = fallbackSearch({
      scope: params.scope,
      target: params.target,
      query: params.query,
      maxMatches: params.maxMatches,
      maxBytes: params.maxBytes,
    });
    return {
      root: displayRoot(params.target.root),
      path: params.target.displayPath,
      query: params.query,
      ...fallback,
    };
  }
}

function filterGitStatus(scope: RepositoryScope, stdout: string): string {
  return stdout
    .split("\n")
    .filter((line) => {
      if (!line.trim() || line.startsWith("##")) {
        return true;
      }
      const rawPaths = line
        .slice(3)
        .split(" -> ")
        .map((item) => item.trim())
        .filter(Boolean);
      return rawPaths.every((rawPath) => !scope.isDenied(rawPath));
    })
    .join("\n")
    .trim();
}

function parseGitChangedPaths(scope: RepositoryScope, output: string): string[] {
  const parts = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < parts.length; ) {
    const status = parts[index++];
    if (!status) {
      break;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[index++];
      const newPath = parts[index++];
      if (oldPath && newPath && !scope.isDenied(oldPath) && !scope.isDenied(newPath)) {
        paths.push(newPath);
      }
      continue;
    }
    const changedPath = parts[index++];
    if (changedPath && !scope.isDenied(changedPath)) {
      paths.push(changedPath);
    }
  }
  return paths;
}

async function gitCommand(params: {
  config: RepositoryToolConfig;
  root: RepositoryRoot;
  args: string[];
  maxBytes?: number;
}): Promise<{ root: string; command: string; output: string; bytes: number; truncated: boolean }> {
  const maxBytes = params.maxBytes ?? params.config.maxSearchBytes;
  const result = await runCommand({
    command: "git",
    args: ["-C", params.root.realPath, ...params.args],
    cwd: params.root.realPath,
    timeoutMs: params.config.commandTimeoutMs,
    maxBuffer: Math.max(maxBytes * 2, 64_000),
  });
  const limited = limitUtf8Bytes(result.stdout.trim(), maxBytes);
  return {
    root: displayRoot(params.root),
    command: `git ${params.args.join(" ")}`,
    output: limited.text,
    bytes: limited.bytes,
    truncated: limited.truncated,
  };
}

async function gitBranch(params: {
  config: RepositoryToolConfig;
  root: RepositoryRoot;
}): Promise<{ root: string; branch: string; detached: boolean; output: string }> {
  try {
    const branch = await gitCommand({
      config: params.config,
      root: params.root,
      args: ["symbolic-ref", "--short", "HEAD"],
      maxBytes: 1_000,
    });
    return {
      root: branch.root,
      branch: branch.output,
      detached: false,
      output: branch.output,
    };
  } catch {
    const commit = await gitCommand({
      config: params.config,
      root: params.root,
      args: ["rev-parse", "--short", "HEAD"],
      maxBytes: 1_000,
    });
    return {
      root: commit.root,
      branch: commit.output,
      detached: true,
      output: `detached:${commit.output}`,
    };
  }
}

async function gitDiffSummary(params: {
  scope: RepositoryScope;
  config: RepositoryToolConfig;
  root: RepositoryRoot;
  maxBytes: number;
}): Promise<{ root: string; command: string; output: string; bytes: number; truncated: boolean }> {
  const changedPaths = await runCommand({
    command: "git",
    args: ["-C", params.root.realPath, "diff", "--name-status", "-z"],
    cwd: params.root.realPath,
    timeoutMs: params.config.commandTimeoutMs,
    maxBuffer: Math.max(params.maxBytes * 2, 64_000),
  });
  const allowedPaths = parseGitChangedPaths(params.scope, changedPaths.stdout).slice(0, 200);
  if (allowedPaths.length === 0) {
    return {
      root: displayRoot(params.root),
      command: "git diff --stat --summary",
      output: "",
      bytes: 0,
      truncated: false,
    };
  }
  return gitCommand({
    config: params.config,
    root: params.root,
    args: ["diff", "--stat", "--summary", "--", ...allowedPaths],
    maxBytes: params.maxBytes,
  });
}

/** Creates read-only repository inspection handlers within configured repository scopes. */
export function createRepositoryToolHandlers(config: RepositoryToolConfig): Partial<Record<string, ToolHandler>> {
  const scope = createRepositoryScope(config);
  return {
    mottbot_repo_list_files: ({ arguments: input }) => {
      const target = scope.resolvePath({
        root: optionalString(input.root),
        targetPath: optionalString(input.path),
      });
      return listFiles({
        scope,
        target,
        recursive: optionalBoolean(input.recursive) ?? false,
        limit: clamp(optionalInteger(input.limit), DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT),
      });
    },
    mottbot_repo_read_file: ({ arguments: input }) => {
      const targetPath = optionalString(input.path);
      if (!targetPath) {
        throw new Error("path is required.");
      }
      const target = scope.resolvePath({
        root: optionalString(input.root),
        targetPath,
      });
      return readFileSlice({
        target,
        startLine: clamp(optionalInteger(input.startLine), 1, 1, Number.MAX_SAFE_INTEGER),
        maxLines: clamp(optionalInteger(input.maxLines), DEFAULT_READ_LINES, 1, MAX_READ_LINES),
        maxBytes: clamp(optionalInteger(input.maxBytes), config.maxReadBytes, 1, config.maxReadBytes),
      });
    },
    mottbot_repo_search: ({ arguments: input }) => {
      const query = optionalString(input.query);
      if (!query) {
        throw new Error("query is required.");
      }
      const target = scope.resolvePath({
        root: optionalString(input.root),
        targetPath: optionalString(input.path),
      });
      return searchRepository({
        scope,
        config,
        target,
        query,
        maxMatches: clamp(optionalInteger(input.maxMatches), config.maxSearchMatches, 1, config.maxSearchMatches),
        maxBytes: clamp(optionalInteger(input.maxBytes), config.maxSearchBytes, 1, config.maxSearchBytes),
      });
    },
    mottbot_git_status: async ({ arguments: input }) => {
      const root = scope.resolveRoot(optionalString(input.root));
      const result = await gitCommand({
        config,
        root,
        args: ["status", "--porcelain", "--branch", "--untracked-files=normal"],
      });
      const filtered = limitUtf8Bytes(filterGitStatus(scope, result.output), config.maxSearchBytes);
      return {
        ...result,
        output: filtered.text,
        bytes: filtered.bytes,
        truncated: result.truncated || filtered.truncated,
      };
    },
    mottbot_git_branch: ({ arguments: input }) => {
      const root = scope.resolveRoot(optionalString(input.root));
      return gitBranch({
        config,
        root,
      });
    },
    mottbot_git_recent_commits: ({ arguments: input }) => {
      const root = scope.resolveRoot(optionalString(input.root));
      const limit = clamp(optionalInteger(input.limit), 10, 1, 50);
      return gitCommand({
        config,
        root,
        args: ["log", "--oneline", "--decorate=no", `-${limit}`],
      });
    },
    mottbot_git_diff: ({ arguments: input }) => {
      const root = scope.resolveRoot(optionalString(input.root));
      const targetPath = optionalString(input.path);
      const maxBytes = clamp(optionalInteger(input.maxBytes), config.maxSearchBytes, 1, config.maxSearchBytes);
      if (!targetPath) {
        return gitDiffSummary({
          scope,
          config,
          root,
          maxBytes,
        });
      }
      const target = scope.resolvePath({
        root: root.label,
        targetPath,
      });
      return gitCommand({
        config,
        root,
        args: ["diff", "--no-ext-diff", "--", target.relativePath],
        maxBytes,
      });
    },
  };
}
