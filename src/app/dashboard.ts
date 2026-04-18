import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import type { AuthProfileStore } from "../codex/auth-store.js";
import type { Logger } from "../shared/logger.js";
import type { AppConfig } from "./config.js";
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

export class DashboardServer {
  private server?: Server;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly health: HealthReporter,
    private readonly authProfiles: AuthProfileStore,
  ) {}

  async start(): Promise<void> {
    if (!this.config.dashboard.enabled || this.server) {
      return;
    }
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.config.dashboard.port, this.config.dashboard.host, () => resolve());
    });
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
    if (!this.isAuthorized(req)) {
      this.writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const { pathname } = requestUrl;
    const htmlPath = this.config.dashboard.path;
    const apiPath = this.config.dashboard.apiPath;

    if (req.method === "GET" && pathname === htmlPath) {
      this.writeHtml(res, this.renderHtml());
      return;
    }
    if (req.method === "GET" && pathname === `${apiPath}/health`) {
      this.writeJson(res, 200, this.health.snapshot());
      return;
    }
    if (req.method === "GET" && pathname === `${apiPath}/config`) {
      this.writeJson(res, 200, this.readDashboardState());
      return;
    }
    if (req.method === "POST" && pathname === `${apiPath}/config`) {
      const body = await this.readBody(req);
      const parsed = editableDashboardConfigSchema.parse(JSON.parse(body));
      const nextState = this.applyDashboardConfig(parsed);
      this.writeJson(res, 200, {
        ok: true,
        restartRequired: true,
        configPath: this.config.configPath,
        state: nextState,
      });
      return;
    }

    this.writeJson(res, 404, { error: "Not found" });
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
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return parsed as Record<string, unknown>;
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      if (chunks.reduce((total, part) => total + part.length, 0) > 1_000_000) {
        throw new Error("Request body too large.");
      }
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
  <h2>Auth profiles</h2>
  <pre id="profiles">Loading...</pre>
  <h2>Status</h2>
  <pre id="status">Idle</pre>
  <script>
    async function loadData() {
      const [configResponse, healthResponse] = await Promise.all([
        fetch("${apiPath}/config"),
        fetch("${apiPath}/health"),
      ]);
      const configPayload = await configResponse.json();
      const healthPayload = await healthResponse.json();
      document.getElementById("modelDefault").value = configPayload.state.models.default;
      document.getElementById("defaultProfile").value = configPayload.state.auth.defaultProfile;
      document.getElementById("preferCliImport").checked = !!configPayload.state.auth.preferCliImport;
      document.getElementById("mentionOnly").checked = !!configPayload.state.behavior.respondInGroupsOnlyWhenMentioned;
      document.getElementById("editThrottleMs").value = String(configPayload.state.behavior.editThrottleMs);
      document.getElementById("polling").checked = !!configPayload.state.telegram.polling;
      document.getElementById("logLevel").value = configPayload.state.logging.level;
      document.getElementById("health").textContent = JSON.stringify(healthPayload, null, 2);
      document.getElementById("profiles").textContent = JSON.stringify(configPayload.authProfiles, null, 2);
    }
    document.getElementById("configForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        models: { default: document.getElementById("modelDefault").value },
        auth: {
          defaultProfile: document.getElementById("defaultProfile").value,
          preferCliImport: document.getElementById("preferCliImport").checked,
        },
        behavior: {
          respondInGroupsOnlyWhenMentioned: document.getElementById("mentionOnly").checked,
          editThrottleMs: Number(document.getElementById("editThrottleMs").value),
        },
        logging: { level: document.getElementById("logLevel").value },
        telegram: { polling: document.getElementById("polling").checked },
      };
      const response = await fetch("${apiPath}/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      document.getElementById("status").textContent = JSON.stringify(body, null, 2);
    });
    loadData().catch((error) => {
      document.getElementById("status").textContent = String(error);
    });
  </script>
</body>
</html>`;
  }
}
