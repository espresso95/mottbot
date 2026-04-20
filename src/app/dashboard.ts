import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { AuthProfileStore } from "../codex/auth-store.js";
import type { MemoryStore, SessionMemorySource } from "../sessions/memory-store.js";
import type { Logger } from "../shared/logger.js";
import type { ToolApprovalDecision, ToolApprovalStore, StoredToolApproval } from "../tools/approval.js";
import type { ServiceRestartScheduled } from "../tools/process-control.js";
import type { ToolDefinition, ToolRegistry } from "../tools/registry.js";
import type { AppConfig } from "./config.js";
import type { OperatorDiagnostics, RecentLogsParams } from "./diagnostics.js";
import type { HealthReporter } from "./health.js";

const editableDashboardConfigSchema = z.object({
  models: z
    .object({
      default: z.string().min(1).optional(),
    })
    .optional(),
  auth: z
    .object({
      defaultProfile: z.string().min(1).optional(),
      preferCliImport: z.boolean().optional(),
    })
    .optional(),
  behavior: z
    .object({
      respondInGroupsOnlyWhenMentioned: z.boolean().optional(),
      editThrottleMs: z.number().int().min(250).optional(),
    })
    .optional(),
  logging: z
    .object({
      level: z.string().min(1).optional(),
    })
    .optional(),
  telegram: z
    .object({
      polling: z.boolean().optional(),
    })
    .optional(),
});

type EditableDashboardConfig = z.infer<typeof editableDashboardConfigSchema>;

const addMemorySchema = z.object({
  sessionKey: z.string().min(1).max(200),
  contentText: z.string().min(1).max(4_000),
  source: z.literal("explicit").optional(),
});
const updateMemorySchema = z.object({
  sessionKey: z.string().min(1).max(200),
  contentText: z.string().min(1).max(4_000),
});
const deleteMemorySchema = z.object({
  sessionKey: z.string().min(1).max(200),
});
const restartServiceSchema = z.object({
  confirm: z.literal("restart"),
  reason: z.string().min(1).max(500).optional(),
  delaySeconds: z.number().int().min(10).max(300).optional(),
});

class DashboardHttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type DashboardRestartService = (params: {
  reason: string;
  delayMs: number;
}) => ServiceRestartScheduled;

export type DashboardServerOptions = {
  diagnostics?: OperatorDiagnostics;
  toolRegistry?: ToolRegistry;
  toolApprovals?: ToolApprovalStore;
  memories?: MemoryStore;
  restartService?: DashboardRestartService;
};

const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|accessToken|refreshToken|botToken|masterKey/i;
const SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:gho_|ghp_|github_pat_)[A-Za-z0-9_]+\b/gi,
  /\bBearer\s+[A-Za-z0-9._-]+\b/gi,
  /\bAuthorization:\s*[^\s]+/gi,
  /\b(?:TELEGRAM_BOT_TOKEN|MOTTBOT_MASTER_KEY|TELEGRAM_API_HASH|OPENAI_API_KEY)\s*=\s*[^\s]+/gi,
];
const TOOL_DECISION_CODES = new Set<ToolApprovalDecision["code"]>([
  "read_only",
  "policy_allowed",
  "policy_missing",
  "role_denied",
  "chat_denied",
  "approval_required",
  "approval_expired",
  "approval_mismatch",
  "approved",
  "operator_approved",
  "revoked",
]);

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function optionalSearchString(requestUrl: URL, key: string): string | undefined {
  const value = requestUrl.searchParams.get(key)?.trim();
  return value ? value : undefined;
}

function searchInteger(requestUrl: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = requestUrl.searchParams.get(key);
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return clampInteger(Number.isInteger(value) ? value : undefined, fallback, min, max);
}

function sanitizeText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[redacted]"), value);
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[redacted]" : sanitizeJsonValue(child),
      ]),
    );
  }
  return value;
}

function summarizeTool(definition: ToolDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    sideEffect: definition.sideEffect,
    enabled: definition.enabled,
    requiresAdmin: definition.requiresAdmin === true,
    timeoutMs: definition.timeoutMs,
    maxOutputBytes: definition.maxOutputBytes,
  };
}

function summarizeApproval(approval: StoredToolApproval) {
  return sanitizeJsonValue({
    id: approval.id,
    sessionKey: approval.sessionKey,
    toolName: approval.toolName,
    approvedByUserId: approval.approvedByUserId,
    reason: approval.reason,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
    requestFingerprint: approval.requestFingerprint,
    previewText: approval.previewText,
  });
}

export class DashboardServer {
  private server?: Server;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly health: HealthReporter,
    private readonly authProfiles: AuthProfileStore,
    private readonly options: DashboardServerOptions = {},
  ) {}

  async start(): Promise<void> {
    if (!this.config.dashboard.enabled || this.server) {
      return;
    }
    this.assertSecureDashboardBinding();
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        this.logger.error(
          {
            error,
            method: req.method,
            url: req.url,
          },
          "Dashboard request failed.",
        );
        if (!res.headersSent && !res.writableEnded) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.config.dashboard.port, this.config.dashboard.host, () => resolve());
      });
    } catch (error) {
      this.server = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      throw error;
    }
    this.logger.info(
      {
        host: this.config.dashboard.host,
        port: this.config.dashboard.port,
        path: this.config.dashboard.path,
      },
      "Dashboard started.",
    );
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const activeServer = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = requestUrl;
    const htmlPath = this.config.dashboard.path;
    const apiPath = this.config.dashboard.apiPath;
    const isApiRequest = pathname.startsWith(`${apiPath}/`);

    if (isApiRequest && !this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && pathname === htmlPath) {
      this.writeHtml(res, this.renderHtml());
      return;
    }
    if (req.method === "GET" && pathname === `${apiPath}/health`) {
      this.writeJson(res, 200, this.health.snapshot());
      return;
    }
    if (req.method === "GET" && pathname === `${apiPath}/runtime`) {
      this.writeJson(res, 200, this.readRuntimeState());
      return;
    }
    if (req.method === "GET" && pathname === `${apiPath}/logs`) {
      this.writeJson(res, 200, this.readLogState(requestUrl));
      return;
    }
    if (req.method === "GET" && pathname === `${apiPath}/tools`) {
      this.writeJson(res, 200, this.readToolState(requestUrl));
      return;
    }
    if (req.method === "GET" && pathname === `${apiPath}/memory`) {
      this.writeJson(res, 200, this.readMemoryState(requestUrl));
      return;
    }
    if (req.method === "POST" && pathname === `${apiPath}/memory`) {
      await this.addMemory(req, res);
      return;
    }
    if (pathname.startsWith(`${apiPath}/memory/`) && (req.method === "PATCH" || req.method === "DELETE")) {
      await this.handleMemoryMutation(req, res, pathname.slice(`${apiPath}/memory/`.length));
      return;
    }
    if (req.method === "POST" && pathname === `${apiPath}/service/restart`) {
      await this.handleServiceRestart(req, res);
      return;
    }
    if (req.method === "GET" && pathname === `${apiPath}/config`) {
      this.writeJson(res, 200, this.readDashboardState());
      return;
    }
    if (req.method === "POST" && pathname === `${apiPath}/config`) {
      try {
        const body = await this.readBody(req);
        const parsed = editableDashboardConfigSchema.parse(JSON.parse(body));
        const nextState = this.applyDashboardConfig(parsed);
        this.writeJson(res, 200, {
          ok: true,
          restartRequired: true,
          configPath: this.config.configPath,
          state: nextState,
        });
      } catch (error) {
        if (error instanceof DashboardHttpError && error.statusCode === 413) {
          this.writeJson(res, 413, { error: "Payload too large" });
          return;
        }
        if (error instanceof SyntaxError || error instanceof z.ZodError) {
          this.writeJson(res, 400, { error: "Invalid request payload" });
          return;
        }
        throw error;
      }
      return;
    }

    this.writeJson(res, 404, { error: "Not found" });
  }

  private readRuntimeState() {
    const diagnostics = this.options.diagnostics;
    const recentRuns = diagnostics?.recentRuns({ limit: 10 }) ?? [];
    const recentErrors = diagnostics?.recentRuns({
      limit: 10,
      statuses: ["failed", "cancelled"],
    }) ?? [];
    return sanitizeJsonValue({
      health: this.health.snapshot(),
      service: {
        statusText: diagnostics?.serviceStatus() ?? "Service diagnostics are not available.",
      },
      agents: diagnostics?.agentDiagnostics() ?? [],
      process: {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        platform: process.platform,
        nodeVersion: process.version,
      },
      recentRuns,
      recentErrors,
    });
  }

  private readLogState(requestUrl: URL) {
    const stream = optionalSearchString(requestUrl, "stream");
    const lines = searchInteger(requestUrl, "lines", 40, 1, 100);
    const params: RecentLogsParams = {
      stream: stream === "stdout" || stream === "stderr" || stream === "both" ? stream : "both",
      lines,
    };
    const text = this.options.diagnostics?.recentLogsText(params) ?? "Log diagnostics are not available.";
    return {
      ...params,
      text: sanitizeText(text),
    };
  }

  private readToolState(requestUrl: URL) {
    const registry = this.options.toolRegistry;
    const approvals = this.options.toolApprovals;
    const limit = searchInteger(requestUrl, "limit", 25, 1, 50);
    const sessionKey = optionalSearchString(requestUrl, "sessionKey");
    const toolName = optionalSearchString(requestUrl, "toolName");
    const rawDecisionCode = optionalSearchString(requestUrl, "decisionCode");
    const decisionCode =
      rawDecisionCode && TOOL_DECISION_CODES.has(rawDecisionCode as ToolApprovalDecision["code"])
        ? (rawDecisionCode as ToolApprovalDecision["code"])
        : undefined;
    return {
      available: Boolean(registry),
      enabledTools: registry?.listEnabled().map(summarizeTool) ?? [],
      modelTools: registry
        ? {
            owner: registry.listModelDeclarations({ includeAdminTools: true }).map((tool) => tool.name),
            admin: registry.listModelDeclarations({ includeAdminTools: true }).map((tool) => tool.name),
            trusted: registry.listModelDeclarations().map((tool) => tool.name),
            user: registry.listModelDeclarations().map((tool) => tool.name),
          }
        : { owner: [], admin: [], trusted: [], user: [] },
      activeApprovals: approvals
        ? sessionKey
          ? approvals.listActive(sessionKey).map(summarizeApproval)
          : approvals.listActiveAll({ limit }).map(summarizeApproval)
        : [],
      recentAudit: approvals
        ? sanitizeJsonValue(
            approvals.listAudit({
              ...(sessionKey ? { sessionKey } : {}),
              ...(toolName ? { toolName } : {}),
              ...(decisionCode ? { decisionCode } : {}),
              limit,
            }),
          )
        : [],
    };
  }

  private readMemoryState(requestUrl: URL) {
    const memories = this.options.memories;
    const sessionKey = optionalSearchString(requestUrl, "sessionKey");
    const source = optionalSearchString(requestUrl, "source");
    const parsedSource =
      source === "explicit" || source === "auto_summary" || source === "model_candidate"
        ? (source as SessionMemorySource)
        : undefined;
    const limit = searchInteger(requestUrl, "limit", 20, 1, 100);
    if (!memories || !sessionKey) {
      return {
        available: Boolean(memories),
        sessionKeyRequired: !sessionKey,
        sessionKey,
        memories: [],
      };
    }
    return sanitizeJsonValue({
      available: true,
      sessionKey,
      source: parsedSource,
      limit,
      memories: memories.list(sessionKey, limit, parsedSource),
    });
  }

  private async addMemory(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const memories = this.options.memories;
    if (!memories) {
      this.writeJson(res, 503, { error: "Memory store is not available." });
      return;
    }
    try {
      const body = await this.readBody(req);
      const parsed = addMemorySchema.parse(JSON.parse(body));
      this.writeJson(res, 200, {
        ok: true,
        memory: sanitizeJsonValue(
          memories.add({
            sessionKey: parsed.sessionKey,
            contentText: parsed.contentText,
            source: parsed.source ?? "explicit",
          }),
        ),
      });
    } catch (error) {
      this.writeMutationError(res, error);
    }
  }

  private async handleMemoryMutation(req: IncomingMessage, res: ServerResponse, rawIdPrefix: string): Promise<void> {
    const memories = this.options.memories;
    if (!memories) {
      this.writeJson(res, 503, { error: "Memory store is not available." });
      return;
    }
    const idPrefix = decodeURIComponent(rawIdPrefix).trim();
    if (!idPrefix) {
      this.writeJson(res, 400, { error: "Memory id is required." });
      return;
    }
    try {
      const body = await this.readBody(req);
      const rawPayload = JSON.parse(body);
      if (req.method === "PATCH") {
        const parsed = updateMemorySchema.parse(rawPayload);
        const memory = memories.update(parsed.sessionKey, idPrefix, parsed.contentText);
        if (!memory) {
          this.writeJson(res, 404, { error: "Memory entry not found or id prefix was ambiguous." });
          return;
        }
        this.writeJson(res, 200, { ok: true, memory: sanitizeJsonValue(memory) });
        return;
      }
      const parsed = deleteMemorySchema.parse(rawPayload);
      if (!memories.remove(parsed.sessionKey, idPrefix)) {
        this.writeJson(res, 404, { error: "Memory entry not found or id prefix was ambiguous." });
        return;
      }
      this.writeJson(res, 200, { ok: true });
    } catch (error) {
      this.writeMutationError(res, error);
    }
  }

  private async handleServiceRestart(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.config.dashboard.authToken?.trim()) {
      this.writeJson(res, 403, { error: "Dashboard auth token is required for service controls." });
      return;
    }
    const restartService = this.options.restartService;
    if (!restartService) {
      this.writeJson(res, 503, { error: "Service restart is not available." });
      return;
    }
    try {
      const body = await this.readBody(req);
      const parsed = restartServiceSchema.parse(JSON.parse(body));
      const delaySeconds = parsed.delaySeconds ?? Math.max(10, Math.ceil(this.config.tools.restartDelayMs / 1000));
      this.writeJson(res, 200, {
        ok: true,
        restart: sanitizeJsonValue(
          restartService({
            reason: parsed.reason ?? "dashboard requested restart",
            delayMs: delaySeconds * 1000,
          }),
        ),
      });
    } catch (error) {
      this.writeMutationError(res, error);
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const expectedToken = this.config.dashboard.authToken?.trim();
    if (!expectedToken) {
      return true;
    }
    const bearer = req.headers.authorization?.trim();
    if (bearer === `Bearer ${expectedToken}`) {
      return true;
    }
    const directToken = req.headers["x-mottbot-dashboard-token"];
    if (typeof directToken === "string" && directToken.trim() === expectedToken) {
      return true;
    }
    return false;
  }

  private isLoopbackHost(host: string | undefined): boolean {
    if (!host) {
      return false;
    }
    const normalizedHost = host.trim().toLowerCase();
    return normalizedHost === "localhost" || normalizedHost === "127.0.0.1" || normalizedHost === "::1";
  }

  private assertSecureDashboardBinding(): void {
    const authToken = this.config.dashboard.authToken?.trim();
    if (authToken || this.isLoopbackHost(this.config.dashboard.host)) {
      return;
    }
    this.logger.error(
      {
        host: this.config.dashboard.host,
        port: this.config.dashboard.port,
        path: this.config.dashboard.path,
      },
      "Refusing to start dashboard without authToken on a non-loopback interface.",
    );
    throw new Error("Dashboard authToken is required when binding to a non-loopback interface.");
  }

  private readDashboardState() {
    const fileConfig = this.readConfigFile();
    return {
      configPath: this.config.configPath,
      restartRequired: true,
      state: {
        models: {
          default: this.config.models.default,
        },
        auth: {
          defaultProfile: this.config.auth.defaultProfile,
          preferCliImport: this.config.auth.preferCliImport,
        },
        behavior: {
          respondInGroupsOnlyWhenMentioned: this.config.behavior.respondInGroupsOnlyWhenMentioned,
          editThrottleMs: this.config.behavior.editThrottleMs,
        },
        logging: {
          level: this.config.logging.level,
        },
        telegram: {
          polling: this.config.telegram.polling,
        },
      },
      fileState: {
        models: fileConfig.models ?? {},
        auth: fileConfig.auth ?? {},
        behavior: fileConfig.behavior ?? {},
        logging: fileConfig.logging ?? {},
        telegram: fileConfig.telegram ?? {},
      },
      authProfiles: this.authProfiles.list().map((profile) => ({
        profileId: profile.profileId,
        source: profile.source,
        email: profile.email,
      })),
      envOverrideNote:
        "Environment variables can override saved config file values until the process is restarted with updated env.",
    };
  }

  private applyDashboardConfig(nextConfig: EditableDashboardConfig) {
    const currentConfig = this.readConfigFile();
    const merged = {
      ...currentConfig,
      models: {
        ...(currentConfig.models ?? {}),
        ...(nextConfig.models ?? {}),
      },
      auth: {
        ...(currentConfig.auth ?? {}),
        ...(nextConfig.auth ?? {}),
      },
      behavior: {
        ...(currentConfig.behavior ?? {}),
        ...(nextConfig.behavior ?? {}),
      },
      logging: {
        ...(currentConfig.logging ?? {}),
        ...(nextConfig.logging ?? {}),
      },
      telegram: {
        ...(currentConfig.telegram ?? {}),
        ...(nextConfig.telegram ?? {}),
      },
    };
    fs.mkdirSync(path.dirname(this.config.configPath), { recursive: true });
    fs.writeFileSync(this.config.configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return merged;
  }

  private readConfigFile(): Record<string, unknown> {
    if (!fs.existsSync(this.config.configPath)) {
      return {};
    }
    const raw = fs.readFileSync(this.config.configPath, "utf8");
    if (!raw.trim()) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return {};
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.logger.warn({ configPath: this.config.configPath }, "Dashboard config file contains invalid JSON.");
        return {};
      }
      throw error;
    }
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalSize += buffer.length;
      if (totalSize > 1_000_000) {
        throw new DashboardHttpError(413, "Payload too large");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private writeHtml(res: ServerResponse, body: string): void {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(body);
  }

  private writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.statusCode = statusCode;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  }

  private writeMutationError(res: ServerResponse, error: unknown): void {
    if (error instanceof DashboardHttpError && error.statusCode === 413) {
      this.writeJson(res, 413, { error: "Payload too large" });
      return;
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      this.writeJson(res, 400, { error: "Invalid request payload" });
      return;
    }
    if (error instanceof Error) {
      this.writeJson(res, 400, { error: sanitizeText(error.message) });
      return;
    }
    this.writeJson(res, 400, { error: "Request failed." });
  }

  private renderHtml(): string {
    const apiPath = this.config.dashboard.apiPath;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mottbot Dashboard</title>
  <style>
    body { font-family: sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
    fieldset { margin-bottom: 1rem; }
    label { display: block; margin: 0.5rem 0; }
    input[type="text"], input[type="number"] { width: 100%; max-width: 480px; }
    pre { background: #f5f5f5; padding: 0.75rem; overflow: auto; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1rem; }
    table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.4rem; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    td { white-space: pre-line; }
  </style>
</head>
<body>
  <h1>Mottbot Dashboard</h1>
  <p>Saved settings are written to <code>${this.config.configPath}</code>. Restart the process after saving.</p>
  <form id="configForm">
    <fieldset>
      <legend>Model</legend>
      <label>Default model <input type="text" id="modelDefault" required /></label>
    </fieldset>
    <fieldset>
      <legend>Auth</legend>
      <label>Default profile <input type="text" id="defaultProfile" required /></label>
      <label><input type="checkbox" id="preferCliImport" /> Prefer CLI import</label>
    </fieldset>
    <fieldset>
      <legend>Behavior</legend>
      <label><input type="checkbox" id="mentionOnly" /> Respond in groups only when mentioned</label>
      <label>Edit throttle (ms) <input type="number" min="250" id="editThrottleMs" required /></label>
    </fieldset>
    <fieldset>
      <legend>Runtime</legend>
      <label><input type="checkbox" id="polling" /> Telegram polling mode</label>
      <label>Log level <input type="text" id="logLevel" required /></label>
    </fieldset>
    <button type="submit">Save configuration</button>
  </form>
  <h2>Health</h2>
  <pre id="health">Loading...</pre>
  <h2>Runtime</h2>
  <button type="button" id="refreshRuntime">Refresh runtime</button>
  <pre id="runtime">Loading...</pre>
  <h2>Agents</h2>
  <button type="button" id="refreshAgents">Refresh agents</button>
  <div id="agents">Loading...</div>
  <h2>Logs</h2>
  <div class="row">
    <label>Stream <input type="text" id="logStream" value="both" /></label>
    <label>Lines <input type="number" min="1" max="100" id="logLines" value="40" /></label>
  </div>
  <button type="button" id="refreshLogs">Refresh logs</button>
  <pre id="logs">Loading...</pre>
  <h2>Tools</h2>
  <button type="button" id="refreshTools">Refresh tools</button>
  <pre id="tools">Loading...</pre>
  <h2>Memory</h2>
  <label>Session key <input type="text" id="memorySessionKey" /></label>
  <label>Memory id prefix <input type="text" id="memoryIdPrefix" /></label>
  <label>Memory text <input type="text" id="memoryText" /></label>
  <button type="button" id="refreshMemory">Refresh memory</button>
  <button type="button" id="addMemory">Add memory</button>
  <button type="button" id="editMemory">Edit memory</button>
  <button type="button" id="deleteMemory">Delete memory</button>
  <pre id="memory">Enter a session key.</pre>
  <h2>Service</h2>
  <label>Restart confirmation <input type="text" id="restartConfirm" /></label>
  <label>Restart reason <input type="text" id="restartReason" /></label>
  <label>Restart delay (seconds) <input type="number" min="10" max="300" id="restartDelaySeconds" value="60" /></label>
  <button type="button" id="restartService">Restart service</button>
  <pre id="service">Idle</pre>
  <h2>Auth profiles</h2>
  <pre id="profiles">Loading...</pre>
  <h2>Status</h2>
  <pre id="status">Idle</pre>
  <fieldset>
    <legend>API token (optional)</legend>
    <label for="apiToken">Dashboard API token</label>
    <input type="password" id="apiToken" autocomplete="off" />
    <button type="button" id="saveToken">Save token</button>
  </fieldset>
  <script>
    /** @returns {HTMLElement} */
    function byId(id) {
      const element = document.getElementById(id);
      if (!element) {
        throw new Error("Missing dashboard element: " + id);
      }
      return element;
    }
    function getAuthHeaders() {
      const token = localStorage.getItem("mottbot.dashboard.token");
      return token ? { "x-mottbot-dashboard-token": token } : {};
    }
    async function apiFetch(url, init = {}) {
      const initHeaders = init.headers || {};
      return fetch(url, {
        ...init,
        headers: {
          ...initHeaders,
          ...getAuthHeaders(),
        },
      });
    }
    function formatLimit(value) {
      return value === undefined || value === null ? "unlimited" : String(value);
    }
    function renderAgents(payload) {
      const container = byId("agents");
      container.textContent = "";
      const agents = Array.isArray(payload.agents) ? payload.agents : [];
      if (agents.length === 0) {
        container.textContent = "No agents reported.";
        return;
      }
      const table = document.createElement("table");
      const header = document.createElement("tr");
      ["Agent", "Model", "Profile", "Limits", "Routes", "Runs"].forEach((label) => {
        const cell = document.createElement("th");
        cell.textContent = label;
        header.appendChild(cell);
      });
      table.appendChild(header);
      agents.forEach((agent) => {
        const row = document.createElement("tr");
        const labels = [];
        labels.push(agent.configured ? "configured" : "stale");
        if (agent.fastMode) labels.push("fast");
        const values = [
          agent.agentId + (agent.displayName ? " (" + agent.displayName + ")" : "") + "\\n" + labels.join(", "),
          agent.modelRef || "",
          agent.profileId || "",
          "concurrent: " + formatLimit(agent.maxConcurrentRuns) + "\\nqueued: " + formatLimit(agent.maxQueuedRuns),
          String(agent.routeCount || 0),
          "queued: " + (agent.queuedRuns || 0) +
            "\\nactive: " + (agent.activeRuns || 0) +
            "\\ncompleted: " + (agent.completedRuns || 0) +
            "\\nfailed: " + (agent.failedRuns || 0) +
            "\\ncancelled: " + (agent.cancelledRuns || 0),
        ];
        values.forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.appendChild(cell);
        });
        table.appendChild(row);
      });
      container.appendChild(table);
    }
    async function loadData() {
      const [configResponse, healthResponse, runtimeResponse, logsResponse, toolsResponse] = await Promise.all([
        apiFetch("${apiPath}/config"),
        apiFetch("${apiPath}/health"),
        apiFetch("${apiPath}/runtime"),
        apiFetch("${apiPath}/logs"),
        apiFetch("${apiPath}/tools"),
      ]);
      const configPayload = await configResponse.json();
      const healthPayload = await healthResponse.json();
      const runtimePayload = await runtimeResponse.json();
      const logsPayload = await logsResponse.json();
      const toolsPayload = await toolsResponse.json();
      byId("modelDefault").value = configPayload.state.models.default;
      byId("defaultProfile").value = configPayload.state.auth.defaultProfile;
      byId("preferCliImport").checked = !!configPayload.state.auth.preferCliImport;
      byId("mentionOnly").checked = !!configPayload.state.behavior.respondInGroupsOnlyWhenMentioned;
      byId("editThrottleMs").value = String(configPayload.state.behavior.editThrottleMs);
      byId("polling").checked = !!configPayload.state.telegram.polling;
      byId("logLevel").value = configPayload.state.logging.level;
      byId("health").textContent = JSON.stringify(healthPayload, null, 2);
      byId("runtime").textContent = JSON.stringify(runtimePayload, null, 2);
      renderAgents(runtimePayload);
      byId("logs").textContent = logsPayload.text || JSON.stringify(logsPayload, null, 2);
      byId("tools").textContent = JSON.stringify(toolsPayload, null, 2);
      byId("profiles").textContent = JSON.stringify(configPayload.authProfiles, null, 2);
    }
    async function loadRuntime() {
      const response = await apiFetch("${apiPath}/runtime");
      const payload = await response.json();
      byId("runtime").textContent = JSON.stringify(payload, null, 2);
      renderAgents(payload);
    }
    async function loadAgents() {
      const response = await apiFetch("${apiPath}/runtime");
      renderAgents(await response.json());
    }
    async function loadLogs() {
      const stream = encodeURIComponent(byId("logStream").value || "both");
      const lines = encodeURIComponent(byId("logLines").value || "40");
      const response = await apiFetch("${apiPath}/logs?stream=" + stream + "&lines=" + lines);
      const payload = await response.json();
      byId("logs").textContent = payload.text || JSON.stringify(payload, null, 2);
    }
    async function loadTools() {
      const response = await apiFetch("${apiPath}/tools");
      byId("tools").textContent = JSON.stringify(await response.json(), null, 2);
    }
    async function loadMemory() {
      const sessionKey = byId("memorySessionKey").value;
      if (!sessionKey) {
        byId("memory").textContent = "Enter a session key.";
        return;
      }
      const response = await apiFetch("${apiPath}/memory?sessionKey=" + encodeURIComponent(sessionKey));
      byId("memory").textContent = JSON.stringify(await response.json(), null, 2);
    }
    byId("configForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        models: { default: byId("modelDefault").value },
        auth: {
          defaultProfile: byId("defaultProfile").value,
          preferCliImport: byId("preferCliImport").checked,
        },
        behavior: {
          respondInGroupsOnlyWhenMentioned: byId("mentionOnly").checked,
          editThrottleMs: Number(byId("editThrottleMs").value),
        },
        logging: { level: byId("logLevel").value },
        telegram: { polling: byId("polling").checked },
      };
      const response = await fetch("${apiPath}/config", {
        method: "POST",
        headers: { "content-type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      byId("status").textContent = JSON.stringify(body, null, 2);
    });
    byId("saveToken").addEventListener("click", () => {
      const token = byId("apiToken").value || "";
      localStorage.setItem("mottbot.dashboard.token", token);
      byId("status").textContent = "Saved dashboard API token for this browser.";
    });
    byId("refreshRuntime").addEventListener("click", () => {
      loadRuntime().catch((error) => {
        byId("status").textContent = String(error);
      });
    });
    byId("refreshAgents").addEventListener("click", () => {
      loadAgents().catch((error) => {
        byId("status").textContent = String(error);
      });
    });
    byId("refreshLogs").addEventListener("click", () => {
      loadLogs().catch((error) => {
        byId("status").textContent = String(error);
      });
    });
    byId("refreshTools").addEventListener("click", () => {
      loadTools().catch((error) => {
        byId("status").textContent = String(error);
      });
    });
    byId("refreshMemory").addEventListener("click", () => {
      loadMemory().catch((error) => {
        byId("status").textContent = String(error);
      });
    });
    byId("addMemory").addEventListener("click", async () => {
      const response = await apiFetch("${apiPath}/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionKey: byId("memorySessionKey").value,
          contentText: byId("memoryText").value,
        }),
      });
      byId("status").textContent = JSON.stringify(await response.json(), null, 2);
      await loadMemory();
    });
    byId("editMemory").addEventListener("click", async () => {
      const response = await apiFetch("${apiPath}/memory/" + encodeURIComponent(byId("memoryIdPrefix").value), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionKey: byId("memorySessionKey").value,
          contentText: byId("memoryText").value,
        }),
      });
      byId("status").textContent = JSON.stringify(await response.json(), null, 2);
      await loadMemory();
    });
    byId("deleteMemory").addEventListener("click", async () => {
      const response = await apiFetch("${apiPath}/memory/" + encodeURIComponent(byId("memoryIdPrefix").value), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionKey: byId("memorySessionKey").value,
        }),
      });
      byId("status").textContent = JSON.stringify(await response.json(), null, 2);
      await loadMemory();
    });
    byId("restartService").addEventListener("click", async () => {
      const response = await apiFetch("${apiPath}/service/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          confirm: byId("restartConfirm").value,
          reason: byId("restartReason").value || undefined,
          delaySeconds: Number(byId("restartDelaySeconds").value || "60"),
        }),
      });
      byId("service").textContent = JSON.stringify(await response.json(), null, 2);
    });
    const savedToken = localStorage.getItem("mottbot.dashboard.token") || "";
    byId("apiToken").value = savedToken;
    loadData().catch((error) => {
      byId("status").textContent = String(error);
    });
  </script>
</body>
</html>`;
  }
}
