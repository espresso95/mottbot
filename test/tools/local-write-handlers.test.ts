import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalWriteToolHandlers } from "../../src/tools/local-write-handlers.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { ToolHandler } from "../../src/tools/executor.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

const definition: ToolDefinition = {
  name: "mottbot_local_note_create",
  description: "Create a local note.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
  sideEffect: "local_write",
  enabled: true,
};

async function runTool(handler: ToolHandler, input: Record<string, unknown>): Promise<unknown> {
  return await handler({
    definition,
    arguments: input,
  });
}

describe("local write tool handlers", () => {
  it("creates new Markdown or text notes under approved roots without returning content", async () => {
    const root = createTempDir();
    try {
      const handlers = createLocalWriteToolHandlers({
        roots: [root],
        deniedPaths: [],
        maxWriteBytes: 1_000,
      });

      const result = await runTool(handlers.mottbot_local_note_create!, {
        path: "drafts/idea.md",
        content: "private draft\n",
      });

      expect(result).toMatchObject({
        ok: true,
        action: "created_file",
        path: "drafts/idea.md",
        sizeBytes: 14,
      });
      expect(JSON.stringify(result)).not.toContain("private draft");
      expect(fs.readFileSync(path.join(root, "drafts/idea.md"), "utf8")).toBe("private draft\n");
      expect(fs.statSync(path.join(root, "drafts/idea.md")).mode & 0o777).toBe(0o600);
    } finally {
      removeTempDir(root);
    }
  });

  it("requires explicit root selection when multiple roots are configured", async () => {
    const firstRoot = createTempDir();
    const secondRoot = createTempDir();
    try {
      const handlers = createLocalWriteToolHandlers({
        roots: [firstRoot, secondRoot],
        deniedPaths: [],
        maxWriteBytes: 1_000,
      });

      await expect(
        runTool(handlers.mottbot_local_note_create!, {
          path: "draft.txt",
          content: "draft\n",
        }),
      ).rejects.toThrow(/Multiple local write roots/);

      const result = await runTool(handlers.mottbot_local_note_create!, {
        root: path.basename(secondRoot),
        path: "draft.txt",
        content: "draft\n",
      });
      expect(result).toMatchObject({
        path: "draft.txt",
      });
      expect(fs.existsSync(path.join(secondRoot, "draft.txt"))).toBe(true);
    } finally {
      removeTempDir(firstRoot);
      removeTempDir(secondRoot);
    }
  });

  it("rejects overwrite, traversal, denied paths, unsupported extensions, and oversized content", async () => {
    const root = createTempDir();
    const outside = createTempDir();
    try {
      fs.writeFileSync(path.join(root, "existing.md"), "existing\n");
      fs.symlinkSync(outside, path.join(root, "outside-link"));
      const handlers = createLocalWriteToolHandlers({
        roots: [root],
        deniedPaths: ["private"],
        maxWriteBytes: 5,
      });

      await expect(
        runTool(handlers.mottbot_local_note_create!, {
          path: "existing.md",
          content: "new\n",
        }),
      ).rejects.toThrow(/already exists/);
      await expect(
        runTool(handlers.mottbot_local_note_create!, {
          path: "../outside.md",
          content: "new\n",
        }),
      ).rejects.toThrow(/outside the approved root/);
      await expect(
        runTool(handlers.mottbot_local_note_create!, {
          path: "%2e%2e/outside.md",
          content: "new\n",
        }),
      ).rejects.toThrow(/outside the approved root/);
      await expect(
        runTool(handlers.mottbot_local_note_create!, {
          path: "private/draft.md",
          content: "new\n",
        }),
      ).rejects.toThrow(/denied/);
      await expect(
        runTool(handlers.mottbot_local_note_create!, {
          path: "script.js",
          content: "new\n",
        }),
      ).rejects.toThrow(/must end in .md or .txt/);
      await expect(
        runTool(handlers.mottbot_local_note_create!, {
          path: "outside-link/draft.md",
          content: "new\n",
        }),
      ).rejects.toThrow(/resolves outside/);
      await expect(
        runTool(handlers.mottbot_local_note_create!, {
          path: "large.md",
          content: "too large\n",
        }),
      ).rejects.toThrow(/exceeding/);
    } finally {
      removeTempDir(root);
      removeTempDir(outside);
    }
  });
});
