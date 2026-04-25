import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalExecToolHandlers } from "../../src/tools/local-exec-handlers.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { ToolHandler } from "../../src/tools/executor.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

const definition: ToolDefinition = {
  name: "mottbot_local_command_run",
  description: "Run a local command.",
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

async function runTool(handler: ToolHandler, input: Record<string, unknown>): Promise<unknown> {
  return await handler({
    definition,
    arguments: input,
  });
}

describe("local exec tool handlers", () => {
  it("runs allowlisted commands inside approved roots with bounded output", async () => {
    const root = createTempDir();
    try {
      fs.writeFileSync(path.join(root, "script.js"), "console.log(process.cwd()); console.error('warn');\n", "utf8");
      const handlers = createLocalExecToolHandlers({
        roots: [root],
        deniedPaths: [],
        allowedCommands: [process.execPath],
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
      });

      const result = await runTool(handlers.mottbot_local_command_run!, {
        command: process.execPath,
        args: ["script.js"],
      });

      expect(result).toMatchObject({
        ok: true,
        command: process.execPath,
        args: ["script.js"],
        cwd: `${path.basename(root)}:.`,
        exitCode: 0,
        stderr: expect.stringContaining("warn"),
        truncated: false,
      });
      expect(JSON.stringify(result)).toContain(root);
    } finally {
      removeTempDir(root);
    }
  });

  it("rejects non-allowlisted commands, shells, traversal, and denied cwd paths", async () => {
    const root = createTempDir();
    try {
      fs.mkdirSync(path.join(root, "private"));
      fs.mkdirSync(path.join(root, ".local"));
      const handlers = createLocalExecToolHandlers({
        roots: [root],
        deniedPaths: ["private"],
        allowedCommands: [process.execPath, "bash"],
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
      });

      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          command: "python3",
        }),
      ).rejects.toThrow(/not allowlisted/);
      const basenameOnlyHandlers = createLocalExecToolHandlers({
        roots: [root],
        deniedPaths: [],
        allowedCommands: [path.basename(process.execPath)],
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
      });
      await expect(
        runTool(basenameOnlyHandlers.mottbot_local_command_run!, {
          command: process.execPath,
        }),
      ).rejects.toThrow(/not allowlisted/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          command: "bash",
        }),
      ).rejects.toThrow(/denied/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          command: process.execPath,
          cwd: "../outside",
        }),
      ).rejects.toThrow(/outside the approved root/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          command: process.execPath,
          cwd: "private",
        }),
      ).rejects.toThrow(/denied/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          command: process.execPath,
          cwd: ".local",
        }),
      ).rejects.toThrow(/denied/);
    } finally {
      removeTempDir(root);
    }
  });

  it("validates roots, command input, root selection, and arguments", async () => {
    const firstRoot = createTempDir();
    const secondRoot = createTempDir();
    const outsideRoot = createTempDir();
    try {
      fs.mkdirSync(path.join(secondRoot, "work"));
      fs.writeFileSync(
        path.join(secondRoot, "work/script.js"),
        "console.log(process.argv.slice(2).join(','));",
        "utf8",
      );
      expect(() =>
        createLocalExecToolHandlers({
          roots: [],
          deniedPaths: [],
          allowedCommands: [process.execPath],
          timeoutMs: 5_000,
          maxOutputBytes: 1_000,
        }),
      ).toThrow(/At least one/);
      const fileRoot = path.join(firstRoot, "not-dir");
      fs.writeFileSync(fileRoot, "file", "utf8");
      expect(() =>
        createLocalExecToolHandlers({
          roots: [fileRoot],
          deniedPaths: [],
          allowedCommands: [process.execPath],
          timeoutMs: 5_000,
          maxOutputBytes: 1_000,
        }),
      ).toThrow(/file already exists|not a directory/);

      const handlers = createLocalExecToolHandlers({
        roots: [firstRoot, secondRoot],
        deniedPaths: [],
        allowedCommands: [process.execPath],
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
      });

      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          command: process.execPath,
        }),
      ).rejects.toThrow(/Multiple local exec roots/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          root: outsideRoot,
          command: process.execPath,
        }),
      ).rejects.toThrow(/not approved/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          root: path.basename(secondRoot),
          cwd: "work",
          command: process.execPath,
          args: ["script.js", "a", "b"],
        }),
      ).resolves.toMatchObject({
        ok: true,
        stdout: "a,b\n",
      });
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          root: path.basename(secondRoot),
          command: "",
        }),
      ).rejects.toThrow(/command is required/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          root: path.basename(secondRoot),
          command: process.execPath,
          args: "bad",
        }),
      ).rejects.toThrow(/args must be an array/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          root: path.basename(secondRoot),
          command: process.execPath,
          args: [null],
        }),
      ).rejects.toThrow(/args\[0\] must be a string/);
      await expect(
        runTool(handlers.mottbot_local_command_run!, {
          root: path.basename(secondRoot),
          command: process.execPath,
          args: ["x\0y"],
        }),
      ).rejects.toThrow(/null byte/);
    } finally {
      removeTempDir(firstRoot);
      removeTempDir(secondRoot);
      removeTempDir(outsideRoot);
    }
  });

  it("captures nonzero exits without throwing", async () => {
    const root = createTempDir();
    try {
      const handlers = createLocalExecToolHandlers({
        roots: [root],
        deniedPaths: [],
        allowedCommands: [process.execPath],
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
      });

      const result = await runTool(handlers.mottbot_local_command_run!, {
        command: process.execPath,
        args: ["-e", "process.stderr.write('bad'); process.exit(3);"],
      });

      expect(result).toMatchObject({
        ok: false,
        exitCode: 3,
        stderr: "bad",
      });
    } finally {
      removeTempDir(root);
    }
  });

  it("bounds command output and reports timeout termination", async () => {
    const root = createTempDir();
    try {
      const handlers = createLocalExecToolHandlers({
        roots: [root],
        deniedPaths: [],
        allowedCommands: [process.execPath],
        timeoutMs: 250,
        maxOutputBytes: 5,
      });

      const output = await runTool(handlers.mottbot_local_command_run!, {
        command: process.execPath,
        args: ["-e", "process.stdout.write('abcdefgh'); process.stderr.write('12345678');"],
      });
      expect(output).toMatchObject({
        ok: true,
        stdout: "abcde",
        stderr: "12345",
        truncated: true,
      });

      const timedOut = await runTool(handlers.mottbot_local_command_run!, {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 1000);"],
      });
      expect(timedOut).toMatchObject({
        ok: false,
        signal: "SIGTERM",
        truncated: true,
      });
    } finally {
      removeTempDir(root);
    }
  });
});
