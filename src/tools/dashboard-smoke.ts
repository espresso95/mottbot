#!/usr/bin/env node
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../app/config.js";
import { loadConfig } from "../app/config.js";
import { DashboardServer } from "../app/dashboard.js";
import { OperatorDiagnostics } from "../app/diagnostics.js";
import { HealthReporter } from "../app/health.js";
import { AuthProfileStore } from "../codex/auth-store.js";
import { DatabaseClient } from "../db/client.js";
import { migrateDatabase } from "../db/migrate.js";
import type { Clock } from "../shared/clock.js";
import { systemClock } from "../shared/clock.js";
import { SecretBox } from "../shared/crypto.js";
import { createLogger } from "../shared/logger.js";

/** Result produced by the dashboard smoke test harness. */
export type DashboardSmokeResult = {
  status: "passed" | "failed";
  url: string;
  apiUrl: string;
  htmlStatus?: number;
  runtimeStatus?: number;
  hasAgentsPanel?: boolean;
  hasAgentRenderer?: boolean;
  agentCount?: number;
  healthStatus?: string;
  firstAgent?: {
    agentId: string;
    configured: boolean;
    routeCount: number;
    queuedRuns: number;
    activeRuns: number;
  };
  error?: string;
};

type DashboardSmokeOptions = {
  config?: AppConfig;
  database?: DatabaseClient;
  clock?: Clock;
  port?: number;
  fetch?: typeof fetch;
};

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a dashboard smoke port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstAgentSummary(value: unknown): DashboardSmokeResult["firstAgent"] {
  const agent = asObject(value);
  if (!agent || typeof agent.agentId !== "string") {
    return undefined;
  }
  return {
    agentId: agent.agentId,
    configured: agent.configured === true,
    routeCount: typeof agent.routeCount === "number" ? agent.routeCount : 0,
    queuedRuns: typeof agent.queuedRuns === "number" ? agent.queuedRuns : 0,
    activeRuns: typeof agent.activeRuns === "number" ? agent.activeRuns : 0,
  };
}

/** Starts a local dashboard instance and verifies the HTML and runtime API surfaces. */
export async function createDashboardSmokeResult(options: DashboardSmokeOptions = {}): Promise<DashboardSmokeResult> {
  const baseConfig = options.config ?? loadConfig();
  const envPort = Number(process.env.MOTTBOT_DASHBOARD_SMOKE_PORT);
  const port = options.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : await findAvailablePort());
  const config: AppConfig = {
    ...baseConfig,
    dashboard: {
      ...baseConfig.dashboard,
      enabled: true,
      host: "127.0.0.1",
      port,
    },
  };
  const ownsDatabase = !options.database;
  const database = options.database ?? new DatabaseClient(config.storage.sqlitePath);
  const clock = options.clock ?? systemClock;
  const dashboardUrl = `http://${config.dashboard.host}:${config.dashboard.port}${config.dashboard.path}`;
  const apiUrl = `http://${config.dashboard.host}:${config.dashboard.port}${config.dashboard.apiPath}/runtime`;
  try {
    migrateDatabase(database);
    const authProfiles = new AuthProfileStore(database, clock, new SecretBox(config.security.masterKey));
    const diagnostics = new OperatorDiagnostics(config, database, clock);
    const health = new HealthReporter(config, database, authProfiles, clock);
    const dashboard = new DashboardServer(config, createLogger("silent"), health, authProfiles, {
      diagnostics,
    });
    await dashboard.start();
    try {
      const requestHeaders = config.dashboard.authToken?.trim()
        ? { "x-mottbot-dashboard-token": config.dashboard.authToken.trim() }
        : undefined;
      const fetchImpl = options.fetch ?? fetch;
      const htmlResponse = await fetchImpl(dashboardUrl);
      const htmlText = await htmlResponse.text();
      const runtimeResponse = await fetchImpl(apiUrl, {
        ...(requestHeaders ? { headers: requestHeaders } : {}),
      });
      const runtimeJson = asObject(await runtimeResponse.json()) ?? {};
      const agents = Array.isArray(runtimeJson.agents) ? runtimeJson.agents : [];
      const healthJson = asObject(runtimeJson.health);
      const hasAgentsPanel = htmlText.includes('id="agents"');
      const hasAgentRenderer = htmlText.includes("renderAgents");
      const passed = htmlResponse.ok && runtimeResponse.ok && hasAgentsPanel && hasAgentRenderer && agents.length > 0;
      const firstAgent = firstAgentSummary(agents[0]);
      return {
        status: passed ? "passed" : "failed",
        url: dashboardUrl,
        apiUrl,
        htmlStatus: htmlResponse.status,
        runtimeStatus: runtimeResponse.status,
        hasAgentsPanel,
        hasAgentRenderer,
        agentCount: agents.length,
        ...(typeof healthJson?.status === "string" ? { healthStatus: healthJson.status } : {}),
        ...(firstAgent ? { firstAgent } : {}),
      };
    } finally {
      await dashboard.stop();
    }
  } catch (error) {
    return {
      status: "failed",
      url: dashboardUrl,
      apiUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (ownsDatabase) {
      database.close();
    }
  }
}

async function main(): Promise<void> {
  const result = await createDashboardSmokeResult();
  printJson(result);
  if (result.status !== "passed") {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
