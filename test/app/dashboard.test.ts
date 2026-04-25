import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";
import { createTestConfig, FakeClock } from "../helpers/fakes.js";
import { DatabaseClient } from "../../src/db/client.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { SecretBox } from "../../src/shared/crypto.js";
import { AuthProfileStore } from "../../src/codex/auth-store.js";
import { HealthReporter } from "../../src/app/health.js";
import { DashboardServer } from "../../src/app/dashboard.js";
import { OperatorDiagnostics } from "../../src/app/diagnostics.js";
import { MemoryStore } from "../../src/sessions/memory-store.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { RunStore } from "../../src/runs/run-store.js";
import { ToolApprovalStore } from "../../src/tools/approval.js";
import { createRuntimeToolRegistry } from "../../src/tools/registry.js";

let requestHandler: ((req: any, res: any) => void) | undefined;

const serverListen = vi.fn((port: number, host: string, callback?: () => void) => {
  callback?.();
});
const serverClose = vi.fn((callback?: (error?: Error) => void) => {
  callback?.();
});
const serverOnce = vi.fn();

vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  return {
    ...actual,
    createServer: vi.fn((handler: (req: any, res: any) => void) => {
      requestHandler = handler;
      return {
        listen: serverListen,
        close: serverClose,
        once: serverOnce,
      };
    }),
  };
});

describe("DashboardServer", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    requestHandler = undefined;
  });

  afterEach(() => {
    while (dirs.length > 0) {
      removeTempDir(dirs.pop()!);
    }
  });

  async function createDashboard(options: { authToken?: string; host?: string; operations?: boolean } = {}) {
    const dir = createTempDir();
    dirs.push(dir);
    const configPath = path.join(dir, "mottbot.config.json");
    const sqlitePath = path.join(dir, "mottbot.sqlite");
    const config = createTestConfig({
      configPath,
      storage: { sqlitePath },
      dashboard: {
        enabled: true,
        host: options.host ?? "127.0.0.1",
        port: 8787,
        path: "/dashboard",
        apiPath: "/api/dashboard",
        authToken: options.authToken,
      },
    });
    fs.writeFileSync(configPath, JSON.stringify({ models: { default: "openai-codex/gpt-5.4" } }), "utf8");
    const database = new DatabaseClient(sqlitePath);
    migrateDatabase(database);
    const clock = new FakeClock();
    const authProfiles = new AuthProfileStore(database, clock, new SecretBox(config.security.masterKey));
    authProfiles.upsert({
      profileId: "openai-codex:default",
      source: "imported_cli",
      accessToken: "access",
      refreshToken: "refresh",
      email: "ops@example.com",
    });
    const health = new HealthReporter(config, database, authProfiles, clock);
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as any;
    const sessions = new SessionStore(database, clock);
    const runs = new RunStore(database, clock);
    const memories = new MemoryStore(database, clock);
    const toolApprovals = new ToolApprovalStore(database, clock);
    const toolRegistry = createRuntimeToolRegistry({ enableSideEffectTools: true });
    const logDir = path.join(dir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const stdoutPath = path.join(logDir, "bot.out.log");
    const stderrPath = path.join(logDir, "bot.err.log");
    fs.writeFileSync(stdoutPath, "started\nBearer fake-dashboard-token\n", "utf8");
    fs.writeFileSync(stderrPath, "warn\nAuthorization: bearer-secret\n", "utf8");
    const diagnostics = new OperatorDiagnostics(config, database, clock, {
      serviceStatus: () => "loaded\npid = 123",
      launchAgentPaths: { stdoutPath, stderrPath },
    });
    const dashboard = new DashboardServer(
      config,
      logger,
      health,
      authProfiles,
      options.operations
        ? {
            diagnostics,
            memories,
            toolApprovals,
            toolRegistry,
            restartService: ({ reason, delayMs }) => ({ scheduled: true, reason, delayMs }),
          }
        : {},
    );
    return { dashboard, database, configPath, logger, sessions, runs, memories, toolApprovals, clock };
  }

  function createResponseCapture() {
    let body = "";
    const headers = new Map<string, string>();
    return {
      statusCode: 0,
      setHeader: (name: string, value: string) => {
        headers.set(name.toLowerCase(), value);
      },
      end: (value?: string) => {
        body = value ?? "";
      },
      get body() {
        return body;
      },
      get headers() {
        return headers;
      },
    };
  }

  async function invokeRequest(req: any, res: any): Promise<void> {
    requestHandler?.(req, res);
    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });
  }

  function createRequest(method: string, url: string, body?: string, headers: Record<string, string> = {}) {
    return {
      method,
      url,
      headers: {
        host: "127.0.0.1:8787",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      [Symbol.asyncIterator]: async function* () {
        if (body !== undefined) {
          yield Buffer.from(body);
        }
      },
    };
  }

  it("serves dashboard HTML", async () => {
    const { dashboard, database } = await createDashboard();
    await dashboard.start();
    const response = createResponseCapture();
    await invokeRequest(createRequest("GET", "/dashboard"), response);
    expect(response.statusCode).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.body).toContain("Mottbot Dashboard");
    expect(response.body).toContain('id="agents"');
    expect(response.body).toContain("renderAgents");
    await dashboard.stop();
    database.close();
  });

  it("allows dashboard HTML while requiring token for API routes", async () => {
    const { dashboard, database } = await createDashboard({ authToken: "secret-token" });
    await dashboard.start();

    const htmlResponse = createResponseCapture();
    await invokeRequest(createRequest("GET", "/dashboard"), htmlResponse);
    expect(htmlResponse.statusCode).toBe(200);

    const apiResponse = createResponseCapture();
    await invokeRequest(createRequest("GET", "/api/dashboard/config"), apiResponse);
    expect(apiResponse.statusCode).toBe(401);

    await dashboard.stop();
    database.close();
  });

  it("serves runtime, logs, tools, and memory panels with redaction", async () => {
    const { dashboard, database, sessions, runs, memories, toolApprovals, clock } = await createDashboard({
      operations: true,
    });
    const session = sessions.ensure({
      sessionKey: "tg:dm:chat-1:user:user-1",
      chatId: "chat-1",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const run = runs.create({
      sessionKey: session.sessionKey,
      modelRef: session.modelRef,
      profileId: session.profileId,
    });
    runs.update(run.runId, {
      status: "failed",
      errorCode: "run_failed",
      errorMessage: "Bearer test-token",
      finishedAt: clock.now(),
    });
    memories.add({
      sessionKey: session.sessionKey,
      contentText: "Remember Bearer fake-dashboard-token",
    });
    toolApprovals.approve({
      sessionKey: session.sessionKey,
      toolName: "mottbot_restart_service",
      approvedByUserId: "admin-1",
      reason: "Bearer tool-token",
      ttlMs: 60_000,
      previewText: "Authorization: another-secret",
    });

    await dashboard.start();

    const runtimeResponse = createResponseCapture();
    await invokeRequest(createRequest("GET", "/api/dashboard/runtime"), runtimeResponse);
    expect(runtimeResponse.statusCode).toBe(200);
    expect(runtimeResponse.body).toContain("run_failed");
    expect(runtimeResponse.body).toContain('"agents"');
    expect(runtimeResponse.body).toContain('"agentId":"main"');
    expect(runtimeResponse.body).not.toContain("test-token");

    const logsResponse = createResponseCapture();
    await invokeRequest(createRequest("GET", "/api/dashboard/logs?stream=both&lines=5"), logsResponse);
    expect(logsResponse.body).toContain("[redacted]");
    expect(logsResponse.body).not.toContain("fake-dashboard-token");
    expect(logsResponse.body).not.toContain("bearer-secret");

    const toolsResponse = createResponseCapture();
    await invokeRequest(createRequest("GET", "/api/dashboard/tools"), toolsResponse);
    const toolsPayload = JSON.parse(toolsResponse.body);
    expect(toolsPayload.enabledTools.some((tool: { name: string }) => tool.name === "mottbot_health_snapshot")).toBe(
      true,
    );
    expect(toolsPayload.modelTools.owner).toContain("mottbot_recent_runs");
    expect(toolsPayload.modelTools.trusted).toContain("mottbot_health_snapshot");
    expect(toolsPayload.modelTools.trusted).not.toContain("mottbot_recent_runs");
    expect(toolsResponse.body).not.toContain("tool-token");
    expect(toolsResponse.body).not.toContain("another-secret");

    const memoryResponse = createResponseCapture();
    await invokeRequest(
      createRequest("GET", `/api/dashboard/memory?sessionKey=${encodeURIComponent(session.sessionKey)}`),
      memoryResponse,
    );
    expect(memoryResponse.body).toContain("[redacted]");
    expect(memoryResponse.body).not.toContain("fake-dashboard-token");

    await dashboard.stop();
    database.close();
  });

  it("adds, updates, and deletes session memory", async () => {
    const { dashboard, database, sessions } = await createDashboard({ operations: true });
    const session = sessions.ensure({
      sessionKey: "tg:dm:chat-2:user:user-1",
      chatId: "chat-2",
      userId: "user-1",
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    await dashboard.start();

    const addResponse = createResponseCapture();
    await invokeRequest(
      createRequest(
        "POST",
        "/api/dashboard/memory",
        JSON.stringify({ sessionKey: session.sessionKey, contentText: " initial memory " }),
      ),
      addResponse,
    );
    expect(addResponse.statusCode).toBe(200);
    const added = JSON.parse(addResponse.body).memory;

    const patchResponse = createResponseCapture();
    await invokeRequest(
      createRequest(
        "PATCH",
        `/api/dashboard/memory/${added.id.slice(0, 8)}`,
        JSON.stringify({ sessionKey: session.sessionKey, contentText: "updated memory" }),
      ),
      patchResponse,
    );
    expect(patchResponse.body).toContain("updated memory");

    const deleteResponse = createResponseCapture();
    await invokeRequest(
      createRequest(
        "DELETE",
        `/api/dashboard/memory/${added.id.slice(0, 8)}`,
        JSON.stringify({ sessionKey: session.sessionKey }),
      ),
      deleteResponse,
    );
    expect(deleteResponse.statusCode).toBe(200);

    await dashboard.stop();
    database.close();
  });

  it("requires configured dashboard auth for service restart controls", async () => {
    const withoutToken = await createDashboard({ operations: true });
    await withoutToken.dashboard.start();
    const forbiddenResponse = createResponseCapture();
    await invokeRequest(
      createRequest("POST", "/api/dashboard/service/restart", JSON.stringify({ confirm: "restart" })),
      forbiddenResponse,
    );
    expect(forbiddenResponse.statusCode).toBe(403);
    await withoutToken.dashboard.stop();
    withoutToken.database.close();

    const withToken = await createDashboard({ authToken: "secret-token", operations: true });
    await withToken.dashboard.start();
    const scheduledResponse = createResponseCapture();
    await invokeRequest(
      createRequest(
        "POST",
        "/api/dashboard/service/restart",
        JSON.stringify({ confirm: "restart", reason: "dashboard test", delaySeconds: 10 }),
        { "x-mottbot-dashboard-token": "secret-token" },
      ),
      scheduledResponse,
    );
    expect(scheduledResponse.statusCode).toBe(200);
    expect(scheduledResponse.body).toContain("dashboard test");
    await withToken.dashboard.stop();
    withToken.database.close();
  });

  it("rejects invalid JSON payloads", async () => {
    const { dashboard, database } = await createDashboard();
    await dashboard.start();
    const response = createResponseCapture();
    await invokeRequest(createRequest("POST", "/api/dashboard/config", "{invalid"), response);
    expect(response.statusCode).toBe(400);
    await dashboard.stop();
    database.close();
  });

  it("rejects oversized payloads", async () => {
    const { dashboard, database } = await createDashboard();
    await dashboard.start();
    const response = createResponseCapture();
    await invokeRequest(createRequest("POST", "/api/dashboard/config", "x".repeat(1_000_001)), response);
    expect(response.statusCode).toBe(413);
    await dashboard.stop();
    database.close();
  });

  it("refuses non-loopback binding without auth token", async () => {
    const { dashboard, database } = await createDashboard({ host: "0.0.0.0" });
    await expect(dashboard.start()).rejects.toThrow(
      "Dashboard authToken is required when binding to a non-loopback interface.",
    );
    database.close();
  });

  it("persists posted config changes", async () => {
    const { dashboard, database, configPath } = await createDashboard();
    await dashboard.start();
    const response = createResponseCapture();
    const body = JSON.stringify({
      models: { default: "openai-codex/gpt-5.4-mini" },
      auth: { defaultProfile: "openai-codex:ops", preferCliImport: false },
      behavior: { respondInGroupsOnlyWhenMentioned: false, editThrottleMs: 500 },
      logging: { level: "debug" },
      telegram: { polling: false },
    });
    await invokeRequest(createRequest("POST", "/api/dashboard/config", body), response);
    expect(response.statusCode).toBe(200);
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(saved.models.default).toBe("openai-codex/gpt-5.4-mini");
    expect(saved.auth.defaultProfile).toBe("openai-codex:ops");
    expect(saved.auth.preferCliImport).toBe(false);
    expect(saved.behavior.editThrottleMs).toBe(500);
    expect(saved.telegram.polling).toBe(false);
    await dashboard.stop();
    database.close();
  });
});
