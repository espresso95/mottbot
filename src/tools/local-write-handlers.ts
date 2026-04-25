import fs from "node:fs";
import crypto from "node:crypto";
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

function assertTextDocumentPath(rawPath: string, decodedPath: string): void {
  if (!/\.(md|txt)$/i.test(decodedPath)) {
    throw new Error(`Local write path ${rawPath} must end in .md or .txt.`);
  }
}

function assertWriteContent(params: { content: string; maxWriteBytes: number }): number {
  const sizeBytes = Buffer.byteLength(params.content, "utf8");
  if (sizeBytes > params.maxWriteBytes) {
    throw new Error(`content is ${sizeBytes} bytes, exceeding the ${params.maxWriteBytes} byte limit.`);
  }
  return sizeBytes;
}

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
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
    assertTextDocumentPath(rawPath, decodedPath);
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

  resolveExistingDocumentPath(params: { root?: string; targetPath: string }): ResolvedLocalWritePath {
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
    assertTextDocumentPath(rawPath, decodedPath);
    const candidate = path.resolve(root.realPath, decodedPath);
    if (!isInside(root.realPath, candidate)) {
      throw new Error(`Local write path ${rawPath} is outside the approved root.`);
    }
    const relativePath = path.relative(root.realPath, candidate);
    if (this.isDenied(relativePath)) {
      throw new Error(`Local write path ${rawPath} is denied by policy.`);
    }
    const realPath = fs.realpathSync(candidate);
    if (!isInside(root.realPath, realPath)) {
      throw new Error(`Local write path ${rawPath} resolves outside the approved root.`);
    }
    const realRelativePath = path.relative(root.realPath, realPath);
    if (this.isDenied(realRelativePath)) {
      throw new Error(`Local write path ${rawPath} is denied by policy.`);
    }
    const stats = fs.statSync(realPath);
    if (!stats.isFile()) {
      throw new Error(`Local write path ${rawPath} is not a file.`);
    }
    return {
      root,
      absolutePath: realPath,
      relativePath: realRelativePath,
      displayPath: normalizeDisplayPath(realRelativePath),
    };
  }

  isDenied(relativePath: string): boolean {
    return this.deniedPaths.some((spec) => matchesDeniedPath(relativePath, spec));
  }
}

function displayRoot(root: LocalWriteRoot): string {
  return `${root.label}:${root.realPath}`;
}

function createNote(params: { target: ResolvedLocalWritePath; content: string; maxWriteBytes: number }): {
  ok: true;
  action: "created_file";
  root: string;
  path: string;
  sizeBytes: number;
  cleanup: string;
} {
  const sizeBytes = assertWriteContent(params);
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

function appendDocument(params: { target: ResolvedLocalWritePath; content: string; maxWriteBytes: number }): {
  ok: true;
  action: "appended_file";
  root: string;
  path: string;
  appendedBytes: number;
  newSizeBytes: number;
  sha256: string;
} {
  const appendedBytes = assertWriteContent(params);
  fs.appendFileSync(params.target.absolutePath, params.content, { encoding: "utf8", mode: 0o600 });
  const next = fs.readFileSync(params.target.absolutePath);
  return {
    ok: true,
    action: "appended_file",
    root: displayRoot(params.target.root),
    path: params.target.displayPath,
    appendedBytes,
    newSizeBytes: next.byteLength,
    sha256: sha256(next),
  };
}

function replaceDocument(params: {
  target: ResolvedLocalWritePath;
  expectedSha256: string;
  content: string;
  maxWriteBytes: number;
}): {
  ok: true;
  action: "replaced_file";
  root: string;
  path: string;
  previousSizeBytes: number;
  newSizeBytes: number;
  sha256: string;
} {
  const newSizeBytes = assertWriteContent(params);
  const previous = fs.readFileSync(params.target.absolutePath);
  const previousSha256 = sha256(previous);
  if (previousSha256 !== params.expectedSha256.toLowerCase()) {
    throw new Error(
      `Local write path ${params.target.displayPath} changed; expected SHA-256 ${params.expectedSha256}.`,
    );
  }
  fs.writeFileSync(params.target.absolutePath, params.content, { encoding: "utf8", mode: 0o600 });
  return {
    ok: true,
    action: "replaced_file",
    root: displayRoot(params.target.root),
    path: params.target.displayPath,
    previousSizeBytes: previous.byteLength,
    newSizeBytes,
    sha256: sha256(Buffer.from(params.content, "utf8")),
  };
}

function readDocument(params: { target: ResolvedLocalWritePath; maxBytes: number }): {
  ok: true;
  action: "read_file";
  root: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  text: string;
  truncated: boolean;
} {
  const content = fs.readFileSync(params.target.absolutePath);
  const truncated = content.byteLength > params.maxBytes;
  const visible = truncated ? content.subarray(0, params.maxBytes) : content;
  return {
    ok: true,
    action: "read_file",
    root: displayRoot(params.target.root),
    path: params.target.displayPath,
    sizeBytes: content.byteLength,
    sha256: sha256(content),
    text: visible.toString("utf8"),
    truncated,
  };
}

export function createLocalWriteToolHandlers(config: LocalWriteToolConfig): Partial<Record<string, ToolHandler>> {
  const scope = new LocalWriteScope(config);
  return {
    mottbot_local_doc_read: ({ arguments: input }) => {
      const targetPath = optionalString(input.path);
      if (!targetPath) {
        throw new Error("path is required.");
      }
      const target = scope.resolveExistingDocumentPath({
        root: optionalString(input.root),
        targetPath,
      });
      const requestedMaxBytes = typeof input.maxBytes === "number" ? input.maxBytes : config.maxWriteBytes;
      return readDocument({
        target,
        maxBytes: Math.min(requestedMaxBytes, config.maxWriteBytes),
      });
    },
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
    mottbot_local_doc_append: ({ arguments: input }) => {
      const targetPath = optionalString(input.path);
      const content = typeof input.content === "string" ? input.content : "";
      if (!targetPath) {
        throw new Error("path is required.");
      }
      if (!content.trim()) {
        throw new Error("content is required.");
      }
      const target = scope.resolveExistingDocumentPath({
        root: optionalString(input.root),
        targetPath,
      });
      return appendDocument({
        target,
        content,
        maxWriteBytes: config.maxWriteBytes,
      });
    },
    mottbot_local_doc_replace: ({ arguments: input }) => {
      const targetPath = optionalString(input.path);
      const expectedSha256 = optionalString(input.expectedSha256);
      const content = typeof input.content === "string" ? input.content : "";
      if (!targetPath) {
        throw new Error("path is required.");
      }
      if (!expectedSha256 || !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
        throw new Error("expectedSha256 must be a 64-character hex SHA-256 value.");
      }
      if (!content.trim()) {
        throw new Error("content is required.");
      }
      const target = scope.resolveExistingDocumentPath({
        root: optionalString(input.root),
        targetPath,
      });
      return replaceDocument({
        target,
        expectedSha256,
        content,
        maxWriteBytes: config.maxWriteBytes,
      });
    },
  };
}
