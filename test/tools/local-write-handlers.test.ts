import fs from "node:fs";
import crypto from "node:crypto";
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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

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

  it("appends and replaces existing Markdown or text documents", async () => {
    const root = createTempDir();
    try {
      const docPath = path.join(root, "docs/plan.md");
      fs.mkdirSync(path.dirname(docPath), { recursive: true });
      fs.writeFileSync(docPath, "one\n", "utf8");
      const handlers = createLocalWriteToolHandlers({
        roots: [root],
        deniedPaths: [],
        maxWriteBytes: 1_000,
      });

      const read = await runTool(handlers.mottbot_local_doc_read!, {
        path: "docs/plan.md",
      });
      expect(read).toMatchObject({
        ok: true,
        action: "read_file",
        path: "docs/plan.md",
        sizeBytes: 4,
        sha256: sha256("one\n"),
        text: "one\n",
        truncated: false,
      });

      const appended = await runTool(handlers.mottbot_local_doc_append!, {
        path: "docs/plan.md",
        content: "two\n",
      });
      expect(appended).toMatchObject({
        ok: true,
        action: "appended_file",
        path: "docs/plan.md",
        appendedBytes: 4,
        newSizeBytes: 8,
        sha256: sha256("one\ntwo\n"),
      });
      expect(fs.readFileSync(docPath, "utf8")).toBe("one\ntwo\n");

      const replaced = await runTool(handlers.mottbot_local_doc_replace!, {
        path: "docs/plan.md",
        expectedSha256: sha256("one\ntwo\n"),
        content: "done\n",
      });
      expect(replaced).toMatchObject({
        ok: true,
        action: "replaced_file",
        path: "docs/plan.md",
        previousSizeBytes: 8,
        newSizeBytes: 5,
        sha256: sha256("done\n"),
      });
      expect(fs.readFileSync(docPath, "utf8")).toBe("done\n");
    } finally {
      removeTempDir(root);
    }
  });

  it("requires matching SHA-256 for document replacement", async () => {
    const root = createTempDir();
    try {
      fs.writeFileSync(path.join(root, "plan.md"), "current\n", "utf8");
      const handlers = createLocalWriteToolHandlers({
        roots: [root],
        deniedPaths: [],
        maxWriteBytes: 1_000,
      });

      await expect(
        runTool(handlers.mottbot_local_doc_replace!, {
          path: "plan.md",
          expectedSha256: sha256("stale\n"),
          content: "next\n",
        }),
      ).rejects.toThrow(/changed/);
      expect(fs.readFileSync(path.join(root, "plan.md"), "utf8")).toBe("current\n");
    } finally {
      removeTempDir(root);
    }
  });

  it("bounds document reads and validates document edit inputs", async () => {
    const root = createTempDir();
    try {
      fs.writeFileSync(path.join(root, "plan.txt"), "abcdef", "utf8");
      const handlers = createLocalWriteToolHandlers({
        roots: [root],
        deniedPaths: [],
        maxWriteBytes: 4,
      });

      const read = await runTool(handlers.mottbot_local_doc_read!, {
        path: "plan.txt",
        maxBytes: 99,
      });
      expect(read).toMatchObject({
        text: "abcd",
        sizeBytes: 6,
        sha256: sha256("abcdef"),
        truncated: true,
      });

      await expect(runTool(handlers.mottbot_local_doc_read!, {})).rejects.toThrow(/path is required/);
      await expect(
        runTool(handlers.mottbot_local_doc_append!, {
          path: "plan.txt",
          content: "   ",
        }),
      ).rejects.toThrow(/content is required/);
      await expect(
        runTool(handlers.mottbot_local_doc_replace!, {
          path: "plan.txt",
          expectedSha256: "not-a-sha",
          content: "next",
        }),
      ).rejects.toThrow(/expectedSha256/);
      await expect(
        runTool(handlers.mottbot_local_doc_replace!, {
          path: "plan.txt",
          expectedSha256: sha256("abcdef"),
          content: "too long",
        }),
      ).rejects.toThrow(/exceeding/);
    } finally {
      removeTempDir(root);
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
      await expect(
        runTool(handlers.mottbot_local_doc_read!, {
          path: "private/secret.md",
        }),
      ).rejects.toThrow(/denied/);
      await expect(
        runTool(handlers.mottbot_local_doc_read!, {
          path: "../outside.md",
        }),
      ).rejects.toThrow(/outside the approved root/);
      await expect(
        runTool(handlers.mottbot_local_doc_read!, {
          path: "outside-link/missing.md",
        }),
      ).rejects.toThrow(/resolves outside|no such file/);
    } finally {
      removeTempDir(root);
      removeTempDir(outside);
    }
  });
});
