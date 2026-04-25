import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSmokeLaneInvocation, createSmokeLaneDoctorReport } from "../../scripts/smoke/smoke-lane.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

function writeLaneConfig(root: string, lane: string, overrides: Record<string, unknown> = {}): string {
  const configPath = path.join(root, ".local", "smoke-lanes", `${lane}.json`);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        telegram: { botToken: "secret-bot-token", adminUserIds: ["123"] },
        security: { masterKey: "secret-master-key" },
        service: { label: `ai.mottbot.bot.${lane}` },
        dashboard: { port: 8788 },
        storage: { sqlitePath: `./data/${lane}/mottbot.sqlite` },
        attachments: { cacheDir: `./data/${lane}/attachments` },
        codexJobs: {
          artifactRoot: `./data/${lane}/codex-jobs`,
        },
        smoke: {
          botUsername: "StartupMottBotLane1",
          sessionPath: `./data/${lane}/telegram-user.session`,
        },
        ...overrides,
      },
      null,
      2,
    ),
  );
  fs.chmodSync(configPath, 0o600);
  return configPath;
}

describe("smoke lane helper", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      removeTempDir(dirs.pop()!);
    }
  });

  it("builds a lane-scoped suite invocation without exposing config secrets", () => {
    const root = createTempDir();
    dirs.push(root);
    const configPath = writeLaneConfig(root, "lane-1");

    const invocation = buildSmokeLaneInvocation(
      ["--lane", "lane-1", "--api-id", "12345", "--api-hash", "secret-api-hash", "--dry-run"],
      root,
    );

    expect(invocation.env).toEqual({ MOTTBOT_CONFIG_PATH: configPath });
    expect(invocation.args).toEqual([
      "pnpm",
      "--silent",
      "smoke:suite",
      "--bot-username",
      "StartupMottBotLane1",
      "--session-path",
      path.join(root, "data", "lane-1", "telegram-user.session"),
      "--api-id",
      "12345",
      "--api-hash",
      "secret-api-hash",
      "--dry-run",
    ]);
    expect(JSON.stringify(invocation.config)).not.toContain("secret-bot-token");
    expect(JSON.stringify(invocation.config)).not.toContain("secret-master-key");
  });

  it("lets explicit smoke flags override lane defaults", () => {
    const root = createTempDir();
    dirs.push(root);
    writeLaneConfig(root, "lane-1");

    const invocation = buildSmokeLaneInvocation(
      [
        "--lane",
        "lane-1",
        "--bot-username",
        "StartupMottBotOverride",
        "--session-path",
        "./override.session",
        "--api-id",
        "12345",
        "--api-hash",
        "hash",
      ],
      root,
    );

    expect(invocation.args).toContain("StartupMottBotOverride");
    expect(invocation.args).toContain("./override.session");
    expect(invocation.args).not.toContain("StartupMottBotLane1");
  });

  it("builds lane-scoped service commands", () => {
    const root = createTempDir();
    dirs.push(root);
    writeLaneConfig(root, "lane-1");

    const invocation = buildSmokeLaneInvocation(["--lane", "lane-1", "--action", "service-restart"], root);

    expect(invocation.args).toEqual(["pnpm", "--silent", "service", "restart"]);
    expect(invocation.env.MOTTBOT_CONFIG_PATH).toBe(path.join(root, ".local", "smoke-lanes", "lane-1.json"));
    expect(invocation.config.serviceLabel).toBe("ai.mottbot.bot.lane-1");
  });

  it("requires lane smoke defaults unless explicit flags are provided", () => {
    const root = createTempDir();
    dirs.push(root);
    writeLaneConfig(root, "lane-1", { smoke: {} });

    expect(() => buildSmokeLaneInvocation(["--lane", "lane-1"], root)).toThrow(/smoke\.botUsername/);
  });

  it("reports a token-free lane doctor result", () => {
    const root = createTempDir();
    dirs.push(root);
    const configPath = writeLaneConfig(root, "lane-1");

    const report = createSmokeLaneDoctorReport(["--lane", "lane-1", "--action", "doctor"], root);

    expect(report).toMatchObject({
      status: "passed",
      configPath,
      lane: "lane-1",
    });
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sqlite path", status: "passed" }),
        expect.objectContaining({ name: "smoke user session path", status: "passed" }),
        expect.objectContaining({ name: "sibling bot token uniqueness", status: "passed" }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain("secret-bot-token");
    expect(JSON.stringify(report)).not.toContain("secret-master-key");
  });

  it("fails doctor when sibling lanes share isolated values", () => {
    const root = createTempDir();
    dirs.push(root);
    writeLaneConfig(root, "lane-1");
    writeLaneConfig(root, "lane-2", {
      service: { label: "ai.mottbot.bot.lane-1" },
      storage: { sqlitePath: "./data/lane-1/mottbot.sqlite" },
    });

    const report = createSmokeLaneDoctorReport(["--lane", "lane-1", "--action", "doctor"], root);

    expect(report.status).toBe("failed");
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sibling service label uniqueness", status: "failed" }),
        expect.objectContaining({ name: "sibling sqlite path uniqueness", status: "failed" }),
        expect.objectContaining({ name: "sibling bot token uniqueness", status: "failed" }),
      ]),
    );
  });
});
