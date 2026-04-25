import { spawn } from "node:child_process";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AppConfig } from "../app/config.js";
import { createId } from "../shared/ids.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { ToolHandler } from "./executor.js";
import { createRepositoryScope, type RepositoryRoot, type RepositoryToolConfig } from "./repository-scope.js";
import { TOOL_GROUPS, type ToolRegistry } from "./registry.js";

type FetchLike = typeof fetch;

const PRIVATE_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);
const MAX_SEARCH_RESULTS = 10;
const DEFAULT_ARTIFACT_ROOT = "data";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeDisplayPath(value: string): string {
  return value.split(path.sep).join("/");
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function titleFromHtml(value: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  return match?.[1] ? stripHtml(match[1]) : undefined;
}

function privateIpAddress(value: string): boolean {
  if (net.isIPv4(value)) {
    const [firstRaw, secondRaw] = value.split(".");
    const first = Number(firstRaw);
    const second = Number(secondRaw);
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (net.isIPv6(value)) {
    const lower = value.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  return false;
}

async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  const hostname = url.hostname.toLowerCase();
  if (PRIVATE_HOSTNAMES.has(hostname) || hostname.endsWith(".local")) {
    throw new Error("Private or local hostnames are not allowed.");
  }
  if (net.isIP(hostname)) {
    if (privateIpAddress(hostname)) {
      throw new Error("Private or local IP addresses are not allowed.");
    }
    return url;
  }
  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.some((entry) => privateIpAddress(entry.address))) {
    throw new Error("Resolved private or local IP addresses are not allowed.");
  }
  return url;
}

async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body) {
    return { text: "", truncated: false };
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const chunk = next.value;
    if (bytes + chunk.byteLength > maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, maxBytes - bytes)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(chunk);
    bytes += chunk.byteLength;
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated,
  };
}

async function fetchPublicText(params: {
  url: string;
  maxBytes: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  method?: "GET" | "POST";
  body?: string;
}): Promise<{
  url: string;
  status: number;
  contentType?: string;
  text: string;
  truncated: boolean;
}> {
  const url = await assertPublicUrl(params.url);
  const response = await (params.fetchImpl ?? fetch)(url, {
    method: params.method ?? "GET",
    headers: {
      accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.8",
      ...(params.body ? { "content-type": "application/json" } : {}),
    },
    body: params.body,
    redirect: "error",
    signal: params.signal,
  });
  const limited = await readResponseText(response, params.maxBytes);
  return {
    url: url.toString(),
    status: response.status,
    ...(response.headers.get("content-type") ? { contentType: response.headers.get("content-type") ?? undefined } : {}),
    text: limited.text,
    truncated: limited.truncated,
  };
}

function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match = /^(?:---|\+\+\+) (?:a\/|b\/)?(.+)$/.exec(line);
    if (!match?.[1] || match[1] === "/dev/null") {
      continue;
    }
    paths.add(match[1].trim());
  }
  return [...paths];
}

function assertPatchPath(scope: ReturnType<typeof createRepositoryScope>, root: RepositoryRoot, rawPath: string): void {
  if (!rawPath || rawPath.includes("\0") || path.isAbsolute(rawPath)) {
    throw new Error(`Patch path ${rawPath || "(empty)"} is not allowed.`);
  }
  const candidate = path.resolve(root.realPath, rawPath);
  if (!isInside(root.realPath, candidate)) {
    throw new Error(`Patch path ${rawPath} escapes the approved root.`);
  }
  const relativePath = path.relative(root.realPath, candidate);
  if (scope.isDenied(relativePath)) {
    throw new Error(`Patch path ${rawPath} is denied by policy.`);
  }
  const parent = path.dirname(candidate);
  if (fs.existsSync(parent)) {
    const realParent = fs.realpathSync(parent);
    if (!isInside(root.realPath, realParent) || scope.isDenied(path.relative(root.realPath, realParent))) {
      throw new Error(`Patch path ${rawPath} resolves through a denied or unsafe parent.`);
    }
  }
  if (fs.existsSync(candidate)) {
    const realPath = fs.realpathSync(candidate);
    if (!isInside(root.realPath, realPath) || scope.isDenied(path.relative(root.realPath, realPath))) {
      throw new Error(`Patch path ${rawPath} resolves outside the approved root.`);
    }
  }
}

async function gitApply(params: {
  command: string;
  cwd: string;
  patch: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, ["apply", "--whitespace=nowarn", "-"], {
      cwd: params.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGTERM"), params.timeoutMs);
    const abort = () => child.kill("SIGTERM");
    params.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", abort);
      resolve({
        ok: exitCode === 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        signal,
      });
    });
    child.stdin.end(params.patch);
  });
}

function artifactDir(name: string): string {
  const dir = path.resolve(DEFAULT_ARTIFACT_ROOT, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeJsonArtifact(
  dirName: string,
  value: Record<string, unknown>,
): { path: string; id: string; sha256: string } {
  const id = createId();
  const filePath = path.join(artifactDir(dirName), `${id}.json`);
  const body = JSON.stringify({ id, ...value }, null, 2);
  fs.writeFileSync(filePath, body, { encoding: "utf8", mode: 0o600 });
  return { path: normalizeDisplayPath(path.relative(process.cwd(), filePath)), id, sha256: sha256(body) };
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Creates handlers for approved repository edit tools. */
export function createRepositoryEditToolHandlers(config: RepositoryToolConfig): Partial<Record<string, ToolHandler>> {
  const scope = createRepositoryScope(config);
  return {
    mottbot_repo_apply_patch: async ({ arguments: input, signal }) => {
      const patch = typeof input.patch === "string" ? input.patch : "";
      if (!patch.trim()) {
        throw new Error("patch is required.");
      }
      const root = scope.resolveRoot(optionalString(input.root));
      if (!fs.existsSync(path.join(root.realPath, ".git"))) {
        throw new Error("Patch tools require an approved git checkout root.");
      }
      const paths = patchPaths(patch);
      if (paths.length === 0) {
        throw new Error("Patch did not contain any file paths.");
      }
      for (const rawPath of paths) {
        assertPatchPath(scope, root, rawPath);
      }
      const result = await gitApply({
        command: "git",
        cwd: root.realPath,
        patch,
        timeoutMs: config.commandTimeoutMs,
        signal,
      });
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || `git apply exited ${result.exitCode ?? result.signal}`);
      }
      return {
        ok: true,
        action: "applied_patch",
        root: `${root.label}:${root.realPath}`,
        paths,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}

/** Creates handlers for bounded local process inspection tools. */
export function createProcessToolHandlers(): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_process_list: async ({ arguments: input, signal }) => {
      const limit = clamp(optionalInteger(input.limit), 25, 1, 100);
      return await new Promise((resolve, reject) => {
        const child = spawn("ps", ["-axo", "pid,ppid,stat,comm,args"], {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks: Buffer[] = [];
        const errors: Buffer[] = [];
        const abort = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
        child.on("error", reject);
        child.on("close", (exitCode) => {
          signal?.removeEventListener("abort", abort);
          if (exitCode !== 0) {
            reject(new Error(Buffer.concat(errors).toString("utf8") || `ps exited ${exitCode}`));
            return;
          }
          const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/).filter(Boolean);
          resolve({ processes: lines.slice(0, limit + 1), truncated: lines.length > limit + 1 });
        });
      });
    },
  };
}

/** Creates handlers for public web fetch, search, snapshot, and webhook tools. */
export function createWebToolHandlers(fetchImpl?: FetchLike): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_web_fetch: async ({ arguments: input, signal }) => {
      const url = optionalString(input.url);
      if (!url) {
        throw new Error("url is required.");
      }
      const maxBytes = clamp(optionalInteger(input.maxBytes), 80_000, 1, 200_000);
      return await fetchPublicText({ url, maxBytes, signal, fetchImpl });
    },
    mottbot_web_search: async ({ arguments: input, signal }) => {
      const query = optionalString(input.query);
      if (!query) {
        throw new Error("query is required.");
      }
      const limit = clamp(optionalInteger(input.limit), 5, 1, MAX_SEARCH_RESULTS);
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const fetched = await fetchPublicText({ url, maxBytes: 120_000, signal, fetchImpl });
      const results = [...fetched.text.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
        .slice(0, limit)
        .map((match) => ({
          title: stripHtml(match[2] ?? ""),
          url: decodeHtmlEntities(match[1] ?? ""),
        }));
      return {
        query,
        source: fetched.url,
        results,
        rawTruncated: fetched.truncated,
      };
    },
    mottbot_browser_snapshot: async ({ arguments: input, signal }) => {
      const url = optionalString(input.url);
      if (!url) {
        throw new Error("url is required.");
      }
      const maxBytes = clamp(optionalInteger(input.maxBytes), 120_000, 1, 200_000);
      const fetched = await fetchPublicText({ url, maxBytes, signal, fetchImpl });
      return {
        url: fetched.url,
        status: fetched.status,
        contentType: fetched.contentType,
        title: titleFromHtml(fetched.text),
        text: stripHtml(fetched.text).slice(0, maxBytes),
        truncated: fetched.truncated,
      };
    },
    mottbot_gateway_webhook_post: async ({ arguments: input, signal }) => {
      const url = optionalString(input.url);
      if (!url) {
        throw new Error("url is required.");
      }
      const payload =
        input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) ? input.payload : {};
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body, "utf8") > 40_000) {
        throw new Error("payload exceeds the 40000 byte limit.");
      }
      const fetched = await fetchPublicText({
        url,
        method: "POST",
        body,
        maxBytes: 80_000,
        signal,
        fetchImpl,
      });
      return {
        ok: fetched.status >= 200 && fetched.status < 300,
        url: fetched.url,
        status: fetched.status,
        response: fetched.text,
        truncated: fetched.truncated,
      };
    },
  };
}

/** Creates handlers that write local canvas, automation, and media request artifacts. */
export function createArtifactToolHandlers(): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_canvas_create: ({ arguments: input }) => {
      const title = optionalString(input.title);
      const body = optionalString(input.body);
      if (!title || !body) {
        throw new Error("title and body are required.");
      }
      const id = createId();
      const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body><main>${body}</main></body>
</html>
`;
      const filePath = path.join(artifactDir("tool-canvas"), `${id}.html`);
      fs.writeFileSync(filePath, html, { encoding: "utf8", mode: 0o600 });
      return {
        ok: true,
        action: "created_canvas",
        id,
        path: normalizeDisplayPath(path.relative(process.cwd(), filePath)),
        sha256: sha256(html),
      };
    },
    mottbot_automation_task_create: ({ arguments: input }) => {
      const title = optionalString(input.title);
      const prompt = optionalString(input.prompt);
      if (!title || !prompt) {
        throw new Error("title and prompt are required.");
      }
      const artifact = writeJsonArtifact("tool-automation", {
        title,
        prompt,
        schedule: optionalString(input.schedule),
        status: "planned",
        createdAt: new Date().toISOString(),
      });
      return { ok: true, action: "created_automation_task", ...artifact };
    },
    mottbot_media_artifact_create: ({ arguments: input }) => {
      const kind = optionalString(input.kind);
      const prompt = optionalString(input.prompt);
      if (!kind || !prompt) {
        throw new Error("kind and prompt are required.");
      }
      const artifact = writeJsonArtifact("tool-media", {
        kind,
        title: optionalString(input.title),
        prompt,
        status: "requested",
        createdAt: new Date().toISOString(),
      });
      return { ok: true, action: "created_media_request", ...artifact };
    },
  };
}

/** Creates handlers for session listing and transcript history tools. */
export function createSessionToolHandlers(params: {
  sessions: SessionStore;
  transcripts: TranscriptStore;
}): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_sessions_list: ({ arguments: input }) => ({
      sessions: params.sessions.listRecent(clamp(optionalInteger(input.limit), 10, 1, 50)),
    }),
    mottbot_session_history: ({ arguments: input }) => {
      const sessionKey = optionalString(input.sessionKey);
      if (!sessionKey) {
        throw new Error("sessionKey is required.");
      }
      return {
        sessionKey,
        messages: params.transcripts
          .listRecent(sessionKey, clamp(optionalInteger(input.limit), 10, 1, 50))
          .map((message) => ({
            id: message.id,
            role: message.role,
            runId: message.runId,
            createdAt: message.createdAt,
            contentText: message.contentText?.slice(0, 2_000),
          })),
      };
    },
  };
}

/** Creates handlers that expose the registered tool catalog and group map. */
export function createToolCatalogHandlers(registry: ToolRegistry): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_tool_catalog: ({ arguments: input }) => {
      const verbose = input.verbose === true;
      const enabled = new Set(registry.listEnabled().map((definition) => definition.name));
      return {
        groups: TOOL_GROUPS,
        tools: registry.listAll().map((definition) => ({
          name: definition.name,
          sideEffect: definition.sideEffect,
          enabled: enabled.has(definition.name),
          requiresAdmin: definition.requiresAdmin === true,
          ...(verbose ? { description: definition.description, inputSchema: definition.inputSchema } : {}),
        })),
      };
    },
  };
}

/** Creates handlers for read-only local extension and MCP manifest discovery. */
export function createExtensionToolHandlers(config: AppConfig): Partial<Record<string, ToolHandler>> {
  const repositoryScope = createRepositoryScope(config.tools.repository);
  return {
    mottbot_extension_catalog: () => ({
      plugins: {
        enabled: false,
        note: "Executable extension plugins are intentionally routed through configured MCP servers.",
      },
      skills: {
        enabled: false,
        note: "Skill loading is a read-only manifest scaffold in Mottbot.",
      },
      mcpServers: config.tools.mcp.servers.map((server) => ({
        name: server.name,
        command: server.command,
        allowedTools: server.allowedTools,
      })),
      codexJobRoots: config.codexJobs.repoRoots,
    }),
    mottbot_extension_manifest_read: ({ arguments: input }) => {
      const targetPath = optionalString(input.path);
      if (!targetPath) {
        throw new Error("path is required.");
      }
      if (!/\.(json|jsonc|md|markdown)$/i.test(targetPath)) {
        throw new Error("Extension manifest path must end in .json, .jsonc, .md, or .markdown.");
      }
      const target = repositoryScope.resolvePath({
        root: optionalString(input.root),
        targetPath,
      });
      const requestedMaxBytes = optionalInteger(input.maxBytes);
      const maxBytes = Math.min(
        requestedMaxBytes ?? config.tools.repository.maxReadBytes,
        config.tools.repository.maxReadBytes,
      );
      const content = fs.readFileSync(target.realPath);
      const truncated = content.byteLength > maxBytes;
      return {
        root: `${target.root.label}:${target.root.realPath}`,
        path: target.displayPath,
        sizeBytes: content.byteLength,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
        text: (truncated ? content.subarray(0, maxBytes) : content).toString("utf8"),
        truncated,
      };
    },
  };
}

/** Creates handlers for listing local automation artifacts. */
export function createAutomationToolHandlers(): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_automation_tasks: ({ arguments: input }) => {
      const limit = clamp(optionalInteger(input.limit), 10, 1, 50);
      const dir = artifactDir("tool-automation");
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(0, limit)
        .map((entry) => {
          const filePath = path.join(dir, entry.name);
          return {
            path: normalizeDisplayPath(path.relative(process.cwd(), filePath)),
            text: fs.readFileSync(filePath, "utf8").slice(0, 4_000),
          };
        });
      return { tasks: entries };
    },
  };
}
