import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OperatorDiagnostics } from "../../src/app/diagnostics.js";
import { createStores } from "../helpers/fakes.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

describe("OperatorDiagnostics", () => {
  it("formats service status, config, recent runs, errors, and logs", () => {
    const stores = createStores({
      agents: {
        defaultId: "main",
        list: [
          {
            id: "main",
            profileId: "openai-codex:default",
            modelRef: "openai-codex/gpt-5.4",
            fastMode: false,
          },
          {
            id: "docs",
            displayName: "Docs",
            profileId: "openai-codex:default",
            modelRef: "openai-codex/gpt-5.4",
            fastMode: true,
            maxConcurrentRuns: 1,
            maxQueuedRuns: 2,
          },
        ],
        bindings: [],
      },
    });
    const logDir = createTempDir();
    try {
      const stdoutPath = path.join(logDir, "out.log");
      const stderrPath = path.join(logDir, "err.log");
      fs.writeFileSync(stdoutPath, "one\ntwo\nthree\n");
      fs.writeFileSync(stderrPath, "warn\nerror\n");
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        agentId: "docs",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
        fastMode: true,
      });
      const run = stores.runs.create({
        sessionKey: session.sessionKey,
        agentId: "docs",
        modelRef: session.modelRef,
        profileId: session.profileId,
      });
      stores.runs.update(run.runId, {
        status: "failed",
        errorCode: "run_failed",
        errorMessage: "boom",
        finishedAt: stores.clock.now(),
      });
      const diagnostics = new OperatorDiagnostics(stores.config, stores.database, stores.clock, {
        serviceStatus: () => "loaded",
        launchAgentPaths: { stdoutPath, stderrPath },
      });

      expect(diagnostics.serviceStatus()).toBe("loaded");
      expect(diagnostics.configText()).toContain("auto memory summaries: disabled");
      expect(diagnostics.recentRunsText({ limit: 1 })).toContain("run_failed");
      expect(diagnostics.recentRunsText({ limit: 1 })).toContain("agent=docs");
      expect(diagnostics.agentDiagnosticsText()).toContain("docs");
      expect(diagnostics.agentDiagnosticsText()).toContain("maxQueued=2");
      expect(diagnostics.agentDiagnosticsText()).toContain("failed=1");
      expect(diagnostics.recentErrorsText(1)).toContain("error");
      expect(diagnostics.recentLogsText({ stream: "stdout", lines: 2 })).toContain("two");
      expect(diagnostics.recentLogsText({ stream: "stderr", lines: 1 })).toContain("error");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
      removeTempDir(logDir);
    }
  });

  it("handles missing logs and unavailable service status", () => {
    const stores = createStores();
    const logDir = createTempDir();
    try {
      const diagnostics = new OperatorDiagnostics(stores.config, stores.database, stores.clock, {
        serviceStatus: () => {
          throw new Error("not available");
        },
        launchAgentPaths: {
          stdoutPath: path.join(logDir, "missing-out.log"),
          stderrPath: path.join(logDir, "missing-err.log"),
        },
      });

      expect(diagnostics.serviceStatus()).toContain("not available");
      expect(diagnostics.recentRunsText()).toBe("No recent runs.");
      expect(diagnostics.recentErrorsText()).toContain("[missing]");
      expect(diagnostics.recentLogsText({ stream: "both", lines: 1 })).toContain("[missing]");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
      removeTempDir(logDir);
    }
  });
});
