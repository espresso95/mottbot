import fs from "node:fs";
import path from "node:path";
import type { ToolHandler } from "./executor.js";

export type LocalWriteToolConfig = {
  roots: string[];
  deniedPaths: string[];
  maxWriteBytes: number;
};

type LocalWriteRoot = {
  label: string;
  originalPath: string;
  realPath: string;
};

type ResolvedLocalWritePath = {
  root: LocalWriteRoot;
  absolutePath: string;
  relativePath: string;
  displayPath: string;
};

const DEFAULT_DENIED_PATHS = [
  ".env",
  ".env.*",
  "mottbot.config.json",
  "auth.json",
  ".codex",
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "*.sqlite*",
  "*.sqlite3*",
  "*.db*",
  "*.log",
  "*.session*",
] as const;

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

class LocalWriteScope {
  private readonly roots: LocalWriteRoot[];
  private readonly deniedPaths: string[];

  constructor(config: LocalWriteToolConfig) {
    this.deniedPaths = [...DEFAULT_DENIED_PATHS, ...config.deniedPaths];
    this.roots = config.roots.map((rootPath) => {
      const absolutePath = path.resolve(rootPath);
      fs.mkdirSync(absolutePath, { recursive: true });
      const realPath = fs.realpathSync(absolutePath);
      const stats = fs.statSync(realPath);
      if (!stats.isDirectory()) {
        throw new Error(`Local write root ${rootPath} is not a directory.`);
      }
      return {
        label: rootLabel(rootPath, realPath),
        originalPath: rootPath,
        realPath,
      };
    });
    if (this.roots.length === 0) {
      throw new Error("At least one local write root must be configured.");
    }
  }

  resolveRoot(rootInput?: string): LocalWriteRoot {
    const trimmed = rootInput?.trim();
    if (!trimmed) {
      if (this.roots.length === 1) {
        return this.roots[0]!;
      }
      throw new Error("Multiple local write roots are configured; pass the root field.");
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
      throw new Error(`Local write root ${trimmed} is ambiguous.`);
    }
    throw new Error(`Local write root ${trimmed} is not approved.`);
  }

  resolveCreatePath(params: { root?: string; targetPath: string }): ResolvedLocalWritePath {
    const root = this.resolveRoot(params.root);
    const rawPath = params.targetPath.trim();
    if (!rawPath) {
      throw new Error("path is required.");
    }
    const decodedPath = decodePathInput(rawPath);
    if (decodedPath.includes("\0")) {
      throw new Error("Local write path contains a null byte.");
    }
    if (path.isAbsolute(decodedPath)) {
      throw new Error("Local write path must be relative to an approved root.");
    }
    if (!/\.(md|txt)$/i.test(decodedPath)) {
      throw new Error("Local write path must end in .md or .txt.");
    }
    const candidate = path.resolve(root.realPath, decodedPath);
    if (!isInside(root.realPath, candidate)) {
      throw new Error(`Local write path ${rawPath} is outside the approved root.`);
    }
    const relativePath = path.relative(root.realPath, candidate);
    if (this.isDenied(relativePath)) {
      throw new Error(`Local write path ${rawPath} is denied by policy.`);
    }
    const parent = path.dirname(candidate);
    fs.mkdirSync(parent, { recursive: true });
    const realParent = fs.realpathSync(parent);
    if (!isInside(root.realPath, realParent)) {
      throw new Error(`Local write path ${rawPath} resolves outside the approved root.`);
    }
    const relativeParent = path.relative(root.realPath, realParent);
    if (relativeParent && this.isDenied(relativeParent)) {
      throw new Error(`Local write path ${rawPath} is denied by policy.`);
    }
    return {
      root,
      absolutePath: candidate,
      relativePath,
      displayPath: normalizeDisplayPath(relativePath),
    };
  }

  isDenied(relativePath: string): boolean {
    return this.deniedPaths.some((spec) => matchesDeniedPath(relativePath, spec));
  }
}

function displayRoot(root: LocalWriteRoot): string {
  return `${root.label}:${root.realPath}`;
}

function createNote(params: {
  target: ResolvedLocalWritePath;
  content: string;
  maxWriteBytes: number;
}): {
  ok: true;
  action: "created_file";
  root: string;
  path: string;
  sizeBytes: number;
  cleanup: string;
} {
  const sizeBytes = Buffer.byteLength(params.content, "utf8");
  if (sizeBytes > params.maxWriteBytes) {
    throw new Error(`content is ${sizeBytes} bytes, exceeding the ${params.maxWriteBytes} byte limit.`);
  }
  if (fs.existsSync(params.target.absolutePath)) {
    throw new Error(`Local write path ${params.target.displayPath} already exists.`);
  }
  const fd = fs.openSync(params.target.absolutePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, params.content, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return {
    ok: true,
    action: "created_file",
    root: displayRoot(params.target.root),
    path: params.target.displayPath,
    sizeBytes,
    cleanup: `Delete ${params.target.displayPath} from ${params.target.root.label} if this draft is no longer needed.`,
  };
}

export function createLocalWriteToolHandlers(config: LocalWriteToolConfig): Partial<Record<string, ToolHandler>> {
  const scope = new LocalWriteScope(config);
  return {
    mottbot_local_note_create: ({ arguments: input }) => {
      const targetPath = optionalString(input.path);
      const content = typeof input.content === "string" ? input.content : "";
      if (!targetPath) {
        throw new Error("path is required.");
      }
      if (!content.trim()) {
        throw new Error("content is required.");
      }
      const target = scope.resolveCreatePath({
        root: optionalString(input.root),
        targetPath,
      });
      return createNote({
        target,
        content,
        maxWriteBytes: config.maxWriteBytes,
      });
    },
  };
}
