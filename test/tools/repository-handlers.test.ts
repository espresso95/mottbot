import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/tools/registry.js";
import { createRepositoryToolHandlers } from "../../src/tools/repository-handlers.js";
import type { ToolHandler } from "../../src/tools/executor.js";
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

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function runTool(handler: ToolHandler, input: Record<string, unknown>): Promise<unknown> {
  return await handler({
    definition,
    arguments: input,
  });
}

function createConfig(root: string) {
  return {
    roots: [root],
    deniedPaths: ["private"],
    maxReadBytes: 200,
    maxSearchMatches: 10,
    maxSearchBytes: 1_000,
    commandTimeoutMs: 5_000,
  };
}

describe("repository tool handlers", () => {
  it("lists, reads, and searches approved files while skipping denied paths", async () => {
    const root = createTempDir();
    try {
      writeFile(path.join(root, "README.md"), "hello repo\n");
      writeFile(path.join(root, "src/index.ts"), "alpha\nneedle\nomega\n");
      writeFile(path.join(root, ".env"), "needle secret\n");
      writeFile(path.join(root, "private/secret.txt"), "needle private\n");
      const handlers = createRepositoryToolHandlers(createConfig(root));

      const listed = await runTool(handlers.mottbot_repo_list_files!, {
        recursive: true,
      });
      expect(listed).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ path: "README.md", type: "file" }),
          expect.objectContaining({ path: "src", type: "directory" }),
          expect.objectContaining({ path: "src/index.ts", type: "file" }),
        ]),
      });
      expect(JSON.stringify(listed)).not.toContain(".env");
      expect(JSON.stringify(listed)).not.toContain("private/secret.txt");

      const read = await runTool(handlers.mottbot_repo_read_file!, {
        path: "src/index.ts",
        startLine: 2,
        maxLines: 1,
      });
      expect(read).toMatchObject({
        path: "src/index.ts",
        startLine: 2,
        endLine: 2,
        text: "needle\n",
      });

      const searched = await runTool(handlers.mottbot_repo_search!, {
        query: "needle",
      });
      expect(searched).toMatchObject({
        matches: [expect.objectContaining({ path: "src/index.ts", lineNumber: 2 })],
      });
      expect(JSON.stringify(searched)).not.toContain("needle secret");
      expect(JSON.stringify(searched)).not.toContain("needle private");
    } finally {
      removeTempDir(root);
    }
  });

  it("bounds listing output and reports symlinks that stay inside the root", async () => {
    const root = createTempDir();
    try {
      writeFile(path.join(root, "linked.txt"), "linked\n");
      writeFile(path.join(root, "nested/first.txt"), "first\n");
      writeFile(path.join(root, "nested/second.txt"), "second\n");
      fs.symlinkSync(path.join(root, "linked.txt"), path.join(root, "safe-link"));
      const handlers = createRepositoryToolHandlers(createConfig(root));

      const listed = await runTool(handlers.mottbot_repo_list_files!, {
        recursive: true,
        limit: 2,
      });
      expect(listed).toMatchObject({
        truncated: true,
        entries: expect.arrayContaining([
          expect.objectContaining({ path: "linked.txt", type: "file" }),
          expect.objectContaining({ path: "nested", type: "directory" }),
        ]),
      });

      const linkOnly = await runTool(handlers.mottbot_repo_list_files!, {
        path: ".",
        limit: 10,
      });
      expect(linkOnly).toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining({ path: "safe-link", type: "symlink" })]),
      });
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects binary reads and truncates large text reads", async () => {
    const root = createTempDir();
    try {
      writeFile(path.join(root, "long.txt"), `${"x".repeat(500)}\n`);
      fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      const handlers = createRepositoryToolHandlers(createConfig(root));

      const read = await runTool(handlers.mottbot_repo_read_file!, {
        path: "long.txt",
        maxBytes: 20,
      });
      expect(read).toMatchObject({
        bytes: 20,
        truncated: true,
      });
      await expect(
        runTool(handlers.mottbot_repo_read_file!, {
          path: "binary.bin",
        }),
      ).rejects.toThrow(/binary/);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects invalid read, list, and search inputs with clear errors", async () => {
    const root = createTempDir();
    try {
      writeFile(path.join(root, "file.txt"), "content\n");
      const handlers = createRepositoryToolHandlers(createConfig(root));

      await expect(runTool(handlers.mottbot_repo_read_file!, {})).rejects.toThrow(/path is required/);
      await expect(
        runTool(handlers.mottbot_repo_list_files!, {
          path: "file.txt",
        }),
      ).rejects.toThrow(/not a directory/);
      await expect(
        runTool(handlers.mottbot_repo_search!, {
          query: "",
        }),
      ).rejects.toThrow(/query is required/);
    } finally {
      removeTempDir(root);
    }
  });

  it("returns empty no-match searches and falls back to node search when ripgrep is unavailable", async () => {
    const root = createTempDir();
    const originalPath = process.env.PATH;
    try {
      writeFile(path.join(root, "src/index.ts"), "alpha\nneedle\nomega\n");
      const handlers = createRepositoryToolHandlers(createConfig(root));

      const noMatch = await runTool(handlers.mottbot_repo_search!, {
        query: "missing",
      });
      expect(noMatch).toMatchObject({
        engine: "rg",
        matches: [],
        truncated: false,
      });

      process.env.PATH = "";
      const fallback = await runTool(handlers.mottbot_repo_search!, {
        path: "src/index.ts",
        query: "needle",
        maxMatches: 1,
      });
      expect(fallback).toMatchObject({
        engine: "node",
        matches: [expect.objectContaining({ path: "src/index.ts", lineNumber: 2 })],
      });
    } finally {
      process.env.PATH = originalPath;
      removeTempDir(root);
    }
  });

  it("truncates repository searches by match count and byte budget", async () => {
    const root = createTempDir();
    try {
      writeFile(path.join(root, "src/one.txt"), "needle one\nneedle two\n");
      writeFile(path.join(root, "src/two.txt"), "needle three\n");
      const handlers = createRepositoryToolHandlers(createConfig(root));

      const byCount = await runTool(handlers.mottbot_repo_search!, {
        query: "needle",
        maxMatches: 1,
      });
      expect(byCount).toMatchObject({
        matches: [expect.objectContaining({ line: expect.stringContaining("needle") })],
        truncated: true,
      });

      const byBytes = await runTool(handlers.mottbot_repo_search!, {
        query: "needle",
        maxBytes: 40,
      });
      expect(byBytes).toMatchObject({
        matches: [],
        truncated: true,
      });
    } finally {
      removeTempDir(root);
    }
  });

  it("returns bounded git status, commits, and diffs without denied files", async () => {
    const root = createTempDir();
    try {
      execFileSync("git", ["init"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: root });
      writeFile(path.join(root, "src/index.ts"), "first\n");
      writeFile(path.join(root, ".env"), "TOKEN=original\n");
      execFileSync("git", ["add", "src/index.ts", ".env"], { cwd: root });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
      writeFile(path.join(root, "src/index.ts"), "first\nsecond\n");
      writeFile(path.join(root, ".env"), "TOKEN=secret\n");
      writeFile(path.join(root, "private/secret.txt"), "secret\n");
      const handlers = createRepositoryToolHandlers(createConfig(root));

      const status = await runTool(handlers.mottbot_git_status!, {});
      expect(status).toMatchObject({
        output: expect.stringContaining("src/index.ts"),
      });
      expect(JSON.stringify(status)).not.toContain(".env");
      expect(JSON.stringify(status)).not.toContain("private/secret.txt");

      const branch = await runTool(handlers.mottbot_git_branch!, {});
      expect(branch).toMatchObject({
        branch: expect.any(String),
        detached: false,
      });

      const commits = await runTool(handlers.mottbot_git_recent_commits!, {
        limit: 1,
      });
      expect(commits).toMatchObject({
        output: expect.stringContaining("initial"),
      });

      const diff = await runTool(handlers.mottbot_git_diff!, {
        path: "src/index.ts",
      });
      expect(diff).toMatchObject({
        output: expect.stringContaining("+second"),
      });

      const summaryDiff = await runTool(handlers.mottbot_git_diff!, {});
      expect(summaryDiff).toMatchObject({
        output: expect.stringContaining("src/index.ts"),
      });
      expect(JSON.stringify(summaryDiff)).not.toContain(".env");
    } finally {
      removeTempDir(root);
    }
  });

  it("surfaces git command failures without exposing denied files", async () => {
    const root = createTempDir();
    try {
      writeFile(path.join(root, "README.md"), "not a git repo\n");
      const handlers = createRepositoryToolHandlers(createConfig(root));

      await expect(runTool(handlers.mottbot_git_status!, {})).rejects.toThrow(/not a git repository/);
    } finally {
      removeTempDir(root);
    }
  });
});
