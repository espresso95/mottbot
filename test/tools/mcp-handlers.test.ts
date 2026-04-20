import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpToolHandlers } from "../../src/tools/mcp-handlers.js";
import type { ToolDefinition } from "../../src/tools/registry.js";
import type { ToolHandler } from "../../src/tools/executor.js";
import { createTempDir, removeTempDir } from "../helpers/tmp.js";

const definition: ToolDefinition = {
  name: "mottbot_mcp_call_tool",
  description: "Call an MCP tool.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  timeoutMs: 1_000,
  maxOutputBytes: 4_000,
  sideEffect: "network_write",
  enabled: true,
};

async function runTool(handler: ToolHandler, input: Record<string, unknown>): Promise<unknown> {
  return await handler({
    definition,
    arguments: input,
  });
}

function writeServer(dir: string): string {
  const serverPath = path.join(dir, "server.mjs");
  fs.writeFileSync(
    serverPath,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    return;
  }
  if (msg.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: "hello " + msg.params.arguments.name }],
        isError: false
      }
    });
  }
});
`,
    "utf8",
  );
  return serverPath;
}

function writeFlexibleServer(dir: string): string {
  const serverPath = path.join(dir, "flex-server.mjs");
  fs.writeFileSync(
    serverPath,
    `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
function send(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    process.stderr.write("ready");
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    return;
  }
  if (msg.method === "tools/call" && msg.params.name === "fail") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "tool failed" } });
    return;
  }
  if (msg.method === "tools/call" && msg.params.name === "large") {
    send({ jsonrpc: "2.0", id: msg.id, result: { text: "abcdefghijklmnopqrstuvwxyz" } });
    return;
  }
  if (msg.method === "tools/call" && msg.params.name === "empty") {
    send({ jsonrpc: "2.0", id: msg.id });
  }
});
`,
    "utf8",
  );
  return serverPath;
}

describe("MCP tool handlers", () => {
  it("calls allowlisted tools on a configured stdio MCP server", async () => {
    const dir = createTempDir();
    try {
      const serverPath = writeServer(dir);
      const handlers = createMcpToolHandlers({
        servers: [
          {
            name: "test_mcp",
            command: process.execPath,
            args: [serverPath],
            allowedTools: ["greet"],
            timeoutMs: 5_000,
            maxOutputBytes: 4_000,
          },
        ],
      });

      const result = await runTool(handlers.mottbot_mcp_call_tool!, {
        server: "test_mcp",
        tool: "greet",
        arguments: { name: "mottbot" },
      });

      expect(result).toMatchObject({
        ok: true,
        server: "test_mcp",
        tool: "greet",
        result: {
          content: [{ type: "text", text: "hello mottbot" }],
          isError: false,
        },
        truncated: false,
      });
    } finally {
      removeTempDir(dir);
    }
  });

  it("rejects unconfigured servers, denied server commands, and non-allowlisted tools", async () => {
    expect(() =>
      createMcpToolHandlers({
        servers: [
          {
            name: "1bad",
            command: process.execPath,
            args: [],
            allowedTools: ["greet"],
            timeoutMs: 1_000,
            maxOutputBytes: 1_000,
          },
        ],
      }),
    ).toThrow(/Invalid MCP server name/);
    expect(() =>
      createMcpToolHandlers({
        servers: [
          {
            name: "bad",
            command: "bash",
            args: [],
            allowedTools: ["greet"],
            timeoutMs: 1_000,
            maxOutputBytes: 1_000,
          },
        ],
      }),
    ).toThrow(/denied/);
    expect(() =>
      createMcpToolHandlers({
        servers: [
          {
            name: "empty_tools",
            command: process.execPath,
            args: [],
            allowedTools: [],
            timeoutMs: 1_000,
            maxOutputBytes: 1_000,
          },
        ],
      }),
    ).toThrow(/must allow/);
    expect(() =>
      createMcpToolHandlers({
        servers: [
          {
            name: "dupe",
            command: process.execPath,
            args: [],
            allowedTools: ["greet"],
            timeoutMs: 1_000,
            maxOutputBytes: 1_000,
          },
          {
            name: "dupe",
            command: process.execPath,
            args: [],
            allowedTools: ["greet"],
            timeoutMs: 1_000,
            maxOutputBytes: 1_000,
          },
        ],
      }),
    ).toThrow(/Duplicate/);

    const handlers = createMcpToolHandlers({
      servers: [
        {
          name: "test_mcp",
          command: process.execPath,
          args: ["missing.mjs"],
          allowedTools: ["greet"],
          timeoutMs: 1_000,
          maxOutputBytes: 1_000,
        },
      ],
    });

    await expect(
      runTool(handlers.mottbot_mcp_call_tool!, {
        server: "missing",
        tool: "greet",
        arguments: {},
      }),
    ).rejects.toThrow(/not configured/);
    await expect(
      runTool(handlers.mottbot_mcp_call_tool!, {
        server: "test_mcp",
        tool: "write_file",
        arguments: {},
      }),
    ).rejects.toThrow(/not allowed/);
    await expect(
      runTool(handlers.mottbot_mcp_call_tool!, {
        server: "",
        tool: "greet",
        arguments: {},
      }),
    ).rejects.toThrow(/server is required/);
    await expect(
      runTool(handlers.mottbot_mcp_call_tool!, {
        server: "test_mcp",
        tool: "",
        arguments: {},
      }),
    ).rejects.toThrow(/tool is required/);
  });

  it("surfaces MCP errors and bounds MCP results", async () => {
    const dir = createTempDir();
    try {
      const serverPath = writeFlexibleServer(dir);
      const handlers = createMcpToolHandlers({
        servers: [
          {
            name: "test_mcp",
            command: process.execPath,
            args: [serverPath],
            allowedTools: ["fail", "large", "empty"],
            timeoutMs: 5_000,
            maxOutputBytes: 20,
          },
        ],
      });

      await expect(
        runTool(handlers.mottbot_mcp_call_tool!, {
          server: "test_mcp",
          tool: "fail",
          arguments: {},
        }),
      ).rejects.toThrow(/tool failed/);
      await expect(
        runTool(handlers.mottbot_mcp_call_tool!, {
          server: "test_mcp",
          tool: "large",
          arguments: "bad",
        }),
      ).rejects.toThrow(/arguments must be an object/);

      const result = await runTool(handlers.mottbot_mcp_call_tool!, {
        server: "test_mcp",
        tool: "large",
        arguments: {},
      });
      expect(result).toMatchObject({
        ok: true,
        server: "test_mcp",
        tool: "large",
        result: {
          truncated: true,
          text: expect.stringContaining("abcdefgh"),
        },
        truncated: true,
        stderr: "ready",
      });

      await expect(
        runTool(handlers.mottbot_mcp_call_tool!, {
          server: "test_mcp",
          tool: "empty",
          arguments: {},
        }),
      ).resolves.toMatchObject({
        ok: true,
        result: null,
        truncated: false,
      });
    } finally {
      removeTempDir(dir);
    }
  });
});
