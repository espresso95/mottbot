import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/app/config.js";
import { createCodexCliToolHandlers } from "../../src/tools/codex-cli-handlers.js";
import type { ToolHandler } from "../../src/tools/executor.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { Clock } from "../../src/shared/clock.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

const definition: ToolDefinition = {
  name: "mottbot_codex_job_start",
  description: "Start Codex.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
  sideEffect: "local_exec",
  enabled: true,
};

function configFor(root: string, command: string): AppConfig {
  return {
    projectTasks: {
      repoRoots: [root],
      artifactRoot: path.join(root, "artifacts"),
      codex: {
        command,
        coderProfile: "mottbot-coder",
        defaultTimeoutMs: 5_000,
      },
    },
  } as AppConfig;
}

async function runTool(handler: ToolHandler, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const output = await handler({
    definition,
    arguments: input,
  });
  return output as Record<string, unknown>;
}

async function waitForStatus(handler: ToolHandler, jobId: string, status: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await runTool(handler, { jobId });
    if (result.status === status) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await runTool(handler, { jobId });
}

describe("codex cli tool handlers", () => {
  it("starts, tails, and reports a Codex CLI job in an approved repository", async () => {
    const root = createTempDir();
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const cliPath = path.join(root, "fake-codex.js");
      fs.writeFileSync(
        cliPath,
        [
          "#!/usr/bin/env node",
          "const fs = require('fs');",
          "const outputIndex = process.argv.indexOf('--output-last-message');",
          "if (outputIndex !== -1) fs.writeFileSync(process.argv[outputIndex + 1], 'tool final');",
          "console.log(JSON.stringify({ type: 'turn.started', text: 'hello' }));",
          "console.log(JSON.stringify({ type: 'turn.completed', message: 'done' }));",
        ].join("\n"),
        { mode: 0o755 },
      );
      const clock: Clock = { now: () => Date.now() };
      const handlers = createCodexCliToolHandlers(configFor(root, cliPath), clock);

      const started = await runTool(handlers.mottbot_codex_job_start!, {
        prompt: "make a change",
      });
      const jobId = String(started.jobId);
      expect(started.status).toBe("streaming");
      expect(started.displayCwd).toBe(`${path.basename(root)}:.`);

      const status = await waitForStatus(handlers.mottbot_codex_job_status!, jobId, "exited");
      expect(status).toMatchObject({
        jobId,
        status: "exited",
        finalMessage: "tool final",
      });

      const tail = await runTool(handlers.mottbot_codex_job_tail!, { jobId, limit: 5 });
      expect(tail.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventType: "turn.started", text: "hello" }),
          expect.objectContaining({ eventType: "turn.completed", message: "done" }),
        ]),
      );
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects unapproved working directories and non-git roots", async () => {
    const root = createTempDir();
    const plainRoot = createTempDir();
    try {
      fs.mkdirSync(path.join(root, ".git"));
      const cliPath = path.join(root, "fake-codex.js");
      fs.writeFileSync(cliPath, "#!/usr/bin/env node\n", { mode: 0o755 });
      const clock: Clock = { now: () => Date.now() };
      const handlers = createCodexCliToolHandlers(configFor(root, cliPath), clock);

      await expect(runTool(handlers.mottbot_codex_job_start!, { prompt: "x", cwd: "../outside" })).rejects.toThrow(
        /outside the approved root/,
      );
      expect(() => createCodexCliToolHandlers(configFor(plainRoot, cliPath), clock)).not.toThrow();
      await expect(
        runTool(createCodexCliToolHandlers(configFor(plainRoot, cliPath), clock).mottbot_codex_job_start!, {
          prompt: "x",
        }),
      ).rejects.toThrow(/git checkout/);
    } finally {
      removeTempDir(root);
      removeTempDir(plainRoot);
    }
  });
});
