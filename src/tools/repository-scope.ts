import fs from "node:fs";
import path from "node:path";

/** Repository tool limits and allowed roots from runtime config. */
export type RepositoryToolConfig = {
  roots: string[];
  deniedPaths: string[];
  maxReadBytes: number;
  maxSearchMatches: number;
  maxSearchBytes: number;
  commandTimeoutMs: number;
};

/** Approved repository root after resolving symlinks and display labels. */
export type RepositoryRoot = {
  label: string;
  originalPath: string;
  realPath: string;
};

/** Path resolved inside an approved repository root with display metadata. */
export type ResolvedRepositoryPath = {
  root: RepositoryRoot;
  absolutePath: string;
  realPath: string;
  relativePath: string;
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

function matchesSpec(value: string, spec: string): boolean {
  return wildcardToRegExp(spec).test(value);
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
    return pathSegments(normalizedRelative).some((segment) => matchesSpec(segment, normalizedSpec));
  }
  return (
    matchesSpec(normalizedRelative, normalizedSpec) ||
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

/** Enforces repository root and denied-path rules for repository tools. */
export class RepositoryScope {
  private readonly roots: RepositoryRoot[];
  private readonly deniedPaths: string[];

  constructor(config: RepositoryToolConfig) {
    this.deniedPaths = [...DEFAULT_DENIED_PATHS, ...config.deniedPaths];
    this.roots = config.roots.map((rootPath) => {
      const absolutePath = path.resolve(rootPath);
      const realPath = fs.realpathSync(absolutePath);
      const stats = fs.statSync(realPath);
      if (!stats.isDirectory()) {
        throw new Error(`Repository root ${rootPath} is not a directory.`);
      }
      return {
        label: rootLabel(rootPath, realPath),
        originalPath: rootPath,
        realPath,
      };
    });
    if (this.roots.length === 0) {
      throw new Error("At least one repository root must be configured.");
    }
  }

  listRoots(): RepositoryRoot[] {
    return [...this.roots];
  }

  rgGlobs(): string[] {
    return this.deniedPaths.flatMap((spec) => {
      const normalized = normalizeDisplayPath(spec).replace(/^\.?\//, "");
      if (!normalized) {
        return [];
      }
      if (normalized.includes("/")) {
        return [`!${normalized}`, `!${normalized}/**`];
      }
      return [`!**/${normalized}`, `!**/${normalized}/**`];
    });
  }

  resolveRoot(rootInput?: string): RepositoryRoot {
    const trimmed = rootInput?.trim();
    if (!trimmed) {
      if (this.roots.length === 1) {
        return this.roots[0]!;
      }
      throw new Error("Multiple repository roots are configured; pass the root field.");
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
      throw new Error(`Repository root ${trimmed} is ambiguous.`);
    }
    throw new Error(`Repository root ${trimmed} is not approved.`);
  }

  resolvePath(params: { root?: string; targetPath?: string }): ResolvedRepositoryPath {
    const root = this.resolveRoot(params.root);
    const rawPath = params.targetPath?.trim() || ".";
    const decodedPath = decodePathInput(rawPath);
    if (decodedPath.includes("\0")) {
      throw new Error("Repository path contains a null byte.");
    }
    const candidate = path.isAbsolute(decodedPath)
      ? path.resolve(decodedPath)
      : path.resolve(root.realPath, decodedPath);
    if (!isInside(root.realPath, candidate)) {
      throw new Error(`Repository path ${rawPath} is outside the approved root.`);
    }
    const candidateRelative = path.relative(root.realPath, candidate);
    if (this.isDenied(candidateRelative)) {
      throw new Error(`Repository path ${rawPath} is denied by policy.`);
    }
    const realPath = fs.realpathSync(candidate);
    if (!isInside(root.realPath, realPath)) {
      throw new Error(`Repository path ${rawPath} resolves outside the approved root.`);
    }
    const relativePath = path.relative(root.realPath, realPath);
    if (this.isDenied(relativePath)) {
      throw new Error(`Repository path ${rawPath} is denied by policy.`);
    }
    const displayPath = normalizeDisplayPath(relativePath || ".");
    return {
      root,
      absolutePath: candidate,
      realPath,
      relativePath,
      displayPath,
    };
  }

  isDenied(relativePath: string): boolean {
    return this.deniedPaths.some((spec) => matchesDeniedPath(relativePath, spec));
  }
}

/** Creates a repository scope from runtime repository tool config. */
export function createRepositoryScope(config: RepositoryToolConfig): RepositoryScope {
  return new RepositoryScope(config);
}
