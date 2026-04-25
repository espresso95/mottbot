import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ToolHandler } from "./executor.js";

/** Configuration for one stdio MCP server exposed through tool handlers. */
export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  allowedTools: string[];
  timeoutMs: number;
  maxOutputBytes: number;
};

/** Runtime MCP tool configuration containing all allowed servers. */
export type McpToolConfig = {
  servers: McpServerConfig[];
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcResponse = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
};

const SERVER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const DENIED_COMMANDS = new Set(["bash", "sh", "zsh", "fish", "sudo", "su", "osascript", "open"]);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function commandBaseName(command: string): string {
  return command.trim().split(/[\\/]/).at(-1) ?? command.trim();
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
}

function boundedJson(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const normalized = value === undefined ? null : value;
  const raw = JSON.stringify(normalized);
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) {
    return { value: normalized, truncated: false };
  }
  return {
    value: {
      truncated: true,
      text: raw.slice(0, maxBytes),
    },
    truncated: true,
  };
}

class McpStdioClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private stderr = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxOutputBytes: number,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-this.maxOutputBytes);
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("close", (code) => {
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`MCP server exited before responding, code ${code ?? "unknown"}.`));
      }
    });
  }

  stderrText(): string {
    return this.stderr.trim();
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
    if (response.error) {
      const message = typeof response.error.message === "string" ? response.error.message : "MCP request failed.";
      throw new Error(message);
    }
    return response.result;
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.child.kill("SIGTERM");
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const response = asObject(parsed);
      if (!response) {
        continue;
      }
      const id = typeof response?.id === "number" ? response.id : undefined;
      if (id === undefined) {
        continue;
      }
      const pending = this.pending.get(id);
      if (!pending) {
        continue;
      }
      this.pending.delete(id);
      pending.resolve(response);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function validateServer(server: McpServerConfig): void {
  if (!SERVER_NAME_PATTERN.test(server.name)) {
    throw new Error(`Invalid MCP server name ${server.name}.`);
  }
  if (DENIED_COMMANDS.has(commandBaseName(server.command))) {
    throw new Error(`MCP server command ${server.command} is denied.`);
  }
  if (server.allowedTools.length === 0) {
    throw new Error(`MCP server ${server.name} must allow at least one tool.`);
  }
}

function normalizeToolArguments(value: unknown): Record<string, JsonValue> {
  const object = asObject(value);
  if (!object) {
    throw new Error("arguments must be an object.");
  }
  return object as Record<string, JsonValue>;
}

/** Creates handlers that call allow-listed tools on configured stdio MCP servers. */
export function createMcpToolHandlers(config: McpToolConfig): Partial<Record<string, ToolHandler>> {
  const servers = new Map<string, McpServerConfig>();
  for (const server of config.servers) {
    validateServer(server);
    if (servers.has(server.name)) {
      throw new Error(`Duplicate MCP server ${server.name}.`);
    }
    servers.set(server.name, server);
  }
  return {
    mottbot_mcp_call_tool: async ({ arguments: input, signal }) => {
      const serverName = optionalString(input.server);
      const toolName = optionalString(input.tool);
      if (!serverName) {
        throw new Error("server is required.");
      }
      if (!toolName) {
        throw new Error("tool is required.");
      }
      const server = servers.get(serverName);
      if (!server) {
        throw new Error(`MCP server ${serverName} is not configured.`);
      }
      if (!server.allowedTools.includes(toolName)) {
        throw new Error(`MCP tool ${toolName} is not allowed for server ${serverName}.`);
      }
      const child = spawn(server.command, server.args, {
        env: minimalEnv(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const client = new McpStdioClient(child, server.maxOutputBytes);
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
      }, server.timeoutMs);
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await client.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "mottbot", version: "0.1.0" },
        });
        client.notify("notifications/initialized");
        const result = await client.request("tools/call", {
          name: toolName,
          arguments: normalizeToolArguments(input.arguments),
        });
        const bounded = boundedJson(result, server.maxOutputBytes);
        return {
          ok: true,
          server: server.name,
          tool: toolName,
          result: bounded.value,
          truncated: bounded.truncated,
          ...(client.stderrText() ? { stderr: client.stderrText() } : {}),
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        client.close();
      }
    },
  };
}
