import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createArtifactToolHandlers,
  createAutomationToolHandlers,
  createExtensionToolHandlers,
  createProcessToolHandlers,
  createRepositoryEditToolHandlers,
  createSessionToolHandlers,
  createToolCatalogHandlers,
  createWebToolHandlers,
} from "../../src/tools/advanced-tool-handlers.js";
import { createRuntimeToolRegistry, toolMatchesAnySelector, type ToolDefinition } from "../../src/tools/registry.js";
import type { ToolHandler } from "../../src/tools/executor.js";
import { createStores, createTestConfig } from "../helpers/fakes.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

const definition: ToolDefinition = {
  name: "test_tool",
  description: "Test tool.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
  sideEffect: "read_only",
  enabled: true,
};

async function runTool(handler: ToolHandler, input: Record<string, unknown>): Promise<unknown> {
  return await handler({
    definition,
    arguments: input,
  });
}

describe("advanced tool handlers", () => {
  it("applies git patches inside approved repository roots and rejects denied paths", async () => {
    const root = createTempDir();
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      fs.writeFileSync(path.join(root, "readme.txt"), "old\n", "utf8");
      const handlers = createRepositoryEditToolHandlers({
        roots: [root],
        deniedPaths: [],
        maxReadBytes: 40_000,
        maxSearchMatches: 100,
        maxSearchBytes: 80_000,
        commandTimeoutMs: 5_000,
      });

      await expect(
        runTool(handlers.mottbot_repo_apply_patch!, {
          patch: [
            "diff --git a/readme.txt b/readme.txt",
            "index 3367afd..ce01362 100644",
            "--- a/readme.txt",
            "+++ b/readme.txt",
            "@@ -1 +1 @@",
            "-old",
            "+hello",
            "",
          ].join("\n"),
        }),
      ).resolves.toMatchObject({
        ok: true,
        action: "applied_patch",
        paths: ["readme.txt"],
      });
      expect(fs.readFileSync(path.join(root, "readme.txt"), "utf8")).toBe("hello\n");

      await expect(
        runTool(handlers.mottbot_repo_apply_patch!, {
          patch: [
            "diff --git a/.env b/.env",
            "new file mode 100644",
            "index 0000000..ce01362",
            "--- /dev/null",
            "+++ b/.env",
            "@@ -0,0 +1 @@",
            "+secret",
            "",
          ].join("\n"),
        }),
      ).rejects.toThrow(/denied by policy/);
    } finally {
      removeTempDir(root);
    }
  });

  it("creates local canvas and media artifacts and lists automation tasks", async () => {
    const root = createTempDir();
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const artifactHandlers = createArtifactToolHandlers();
      const automationHandlers = createAutomationToolHandlers();

      await expect(
        runTool(artifactHandlers.mottbot_canvas_create!, {
          title: "Canvas",
          body: "<p>hello</p>",
        }),
      ).resolves.toMatchObject({
        ok: true,
        action: "created_canvas",
      });
      await expect(
        runTool(artifactHandlers.mottbot_automation_task_create!, {
          title: "Daily check",
          prompt: "Check status",
          schedule: "daily",
        }),
      ).resolves.toMatchObject({
        ok: true,
        action: "created_automation_task",
      });
      await expect(
        runTool(artifactHandlers.mottbot_media_artifact_create!, {
          kind: "image",
          prompt: "A diagram",
        }),
      ).resolves.toMatchObject({
        ok: true,
        action: "created_media_request",
      });
      await expect(runTool(automationHandlers.mottbot_automation_tasks!, {})).resolves.toMatchObject({
        tasks: [expect.objectContaining({ text: expect.stringContaining("Daily check") })],
      });
    } finally {
      process.chdir(previousCwd);
      removeTempDir(root);
    }
  });

  it("lists sessions, session history, tool catalog, and group selector matches", async () => {
    const stores = createStores();
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      stores.transcripts.add({
        sessionKey: session.sessionKey,
        role: "user",
        contentText: "hello",
      });
      const sessionHandlers = createSessionToolHandlers({
        sessions: stores.sessions,
        transcripts: stores.transcripts,
      });
      const registry = createRuntimeToolRegistry({ enableSideEffectTools: true });
      const catalogHandlers = createToolCatalogHandlers(registry);
      const repoPatchDefinition = registry.listAll().find((tool) => tool.name === "mottbot_repo_apply_patch")!;

      await expect(runTool(sessionHandlers.mottbot_sessions_list!, {})).resolves.toMatchObject({
        sessions: [expect.objectContaining({ sessionKey: session.sessionKey })],
      });
      await expect(
        runTool(sessionHandlers.mottbot_session_history!, {
          sessionKey: session.sessionKey,
        }),
      ).resolves.toMatchObject({
        messages: [expect.objectContaining({ contentText: "hello" })],
      });
      await expect(runTool(catalogHandlers.mottbot_tool_catalog!, {})).resolves.toMatchObject({
        groups: expect.objectContaining({ fs: expect.arrayContaining(["mottbot_repo_apply_patch"]) }),
      });
      expect(toolMatchesAnySelector(repoPatchDefinition, ["group:fs"])).toBe(true);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("runs public web handlers through a bounded fetch boundary", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      fetchCalls.push({ url: String(input), init });
      return new Response("<html><title>Page</title><body>Hello page</body></html>", {
        status: 201,
        headers: { "content-type": "text/html" },
      });
    };
    const handlers = createWebToolHandlers(fetchImpl);

    await expect(
      runTool(handlers.mottbot_web_fetch!, {
        url: "https://93.184.216.34/fetch",
        maxBytes: 20,
      }),
    ).resolves.toMatchObject({
      url: "https://93.184.216.34/fetch",
      status: 201,
      truncated: true,
    });
    await expect(
      runTool(handlers.mottbot_browser_snapshot!, {
        url: "https://93.184.216.34/page",
      }),
    ).resolves.toMatchObject({
      title: "Page",
      text: expect.stringContaining("Hello page"),
    });
    await expect(
      runTool(handlers.mottbot_gateway_webhook_post!, {
        url: "https://93.184.216.34/hook",
        payload: { ok: true },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 201,
    });
    expect(fetchCalls.at(-1)?.init?.method).toBe("POST");

    await expect(
      runTool(handlers.mottbot_web_fetch!, {
        url: "http://localhost/private",
      }),
    ).rejects.toThrow(/Private or local hostnames/);
  });

  it("lists local processes without exposing environment details", async () => {
    const handlers = createProcessToolHandlers();

    await expect(
      runTool(handlers.mottbot_process_list!, {
        limit: 1,
      }),
    ).resolves.toMatchObject({
      processes: expect.arrayContaining([expect.stringContaining("PID")]),
      truncated: expect.any(Boolean),
    });
  });

  it("reads extension catalog and approved manifest files", async () => {
    const config = createTestConfig();
    const root = path.dirname(config.configPath);
    try {
      fs.writeFileSync(path.join(root, "plugin.json"), '{"name":"demo"}\n', "utf8");
      config.tools.repository.roots = [root];
      config.tools.mcp.servers = [
        {
          name: "demo",
          command: "node",
          args: ["server.js"],
          allowedTools: ["demo_tool"],
          timeoutMs: 1_000,
          maxOutputBytes: 4_000,
        },
      ];
      config.codexJobs.repoRoots = [root];
      const handlers = createExtensionToolHandlers(config);

      await expect(runTool(handlers.mottbot_extension_catalog!, {})).resolves.toMatchObject({
        plugins: { enabled: false },
        mcpServers: [expect.objectContaining({ name: "demo", allowedTools: ["demo_tool"] })],
        codexJobRoots: [root],
      });
      await expect(
        runTool(handlers.mottbot_extension_manifest_read!, {
          path: "plugin.json",
          maxBytes: 1_000,
        }),
      ).resolves.toMatchObject({
        path: "plugin.json",
        text: '{"name":"demo"}\n',
        truncated: false,
      });
    } finally {
      removeTempDir(root);
    }
  });
});
