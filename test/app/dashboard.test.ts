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

  async function createDashboard(options: { authToken?: string } = {}) {
    const dir = createTempDir();
    dirs.push(dir);
    const configPath = path.join(dir, "mottbot.config.json");
    const sqlitePath = path.join(dir, "mottbot.sqlite");
    const config = createTestConfig({
      configPath,
      storage: { sqlitePath },
      dashboard: {
        enabled: true,
        host: "127.0.0.1",
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
    const dashboard = new DashboardServer(config, { info: vi.fn(), error: vi.fn() } as any, health, authProfiles);
    return { dashboard, database, configPath };
  }

  function createResponseCapture() {
    let body = "";
    const headers = new Map<string, string>();
    const response = {
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
    return response;
  }

  it("serves dashboard HTML", async () => {
    const { dashboard, database } = await createDashboard();
    await dashboard.start();
    const response = createResponseCapture();
    await requestHandler?.(
      {
        method: "GET",
        url: "/dashboard",
        headers: { host: "127.0.0.1:8787" },
        [Symbol.asyncIterator]: async function* () {},
      },
      response,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.body).toContain("Mottbot Dashboard");
    await dashboard.stop();
    database.close();
  });

  it("rejects unauthorized requests when auth token is set", async () => {
    const { dashboard, database } = await createDashboard({ authToken: "secret-token" });
    await dashboard.start();
    const response = createResponseCapture();
    await requestHandler?.(
      {
        method: "GET",
        url: "/api/dashboard/config",
        headers: { host: "127.0.0.1:8787" },
        [Symbol.asyncIterator]: async function* () {},
      },
      response,
    );
    expect(response.statusCode).toBe(401);
    await dashboard.stop();
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
    await requestHandler?.(
      {
        method: "POST",
        url: "/api/dashboard/config",
        headers: { host: "127.0.0.1:8787", "content-type": "application/json" },
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(body);
        },
      },
      response,
    );
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
