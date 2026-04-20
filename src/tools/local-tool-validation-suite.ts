#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseClient } from "../db/client.js";
import { migrateDatabase } from "../db/migrate.js";
import type { Clock } from "../shared/clock.js";
import { SessionStore } from "../sessions/session-store.js";
import { ToolApprovalStore } from "./approval.js";
import { ToolExecutor, type ToolExecutionResult } from "./executor.js";
import { createToolRequestFingerprint } from "./policy.js";
import { createRuntimeToolRegistry } from "./registry.js";
import { createLocalExecToolHandlers } from "./local-exec-handlers.js";
import { createLocalWriteToolHandlers } from "./local-write-handlers.js";
import { createMcpToolHandlers } from "./mcp-handlers.js";

type LocalToolScenarioStatus = "passed" | "failed";

export type LocalToolScenarioResult = {
  name: string;
  status: LocalToolScenarioStatus;
  details?: Record<string, unknown>;
  error?: string;
};

export type LocalToolValidationSuiteResult = {
  status: LocalToolScenarioStatus;
  tempRoot: string;
  scenarios: LocalToolScenarioResult[];
};

const ADMIN_USER_ID = "local-tool-validation-admin";
const SESSION_KEY = "local-tool-validation-session";

class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeMcpEchoServer(filePath: string): void {
  fs.writeFileSync(
    filePath,
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
  if (msg.method === "tools/call" && msg.params.name === "echo") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        content: [{ type: "text", text: "echo:" + msg.params.arguments.text }],
        isError: false
      }
    });
  }
});
`,
    "utf8",
  );
}

function parseToolJson(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) {
    throw new Error(result.contentText);
  }
  const parsed = JSON.parse(result.contentText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Tool ${result.toolName} returned non-object JSON.`);
  }
  return parsed as Record<string, unknown>;
}

function assertToolPassed(result: ToolExecutionResult): void {
  if (result.isError) {
    throw new Error(result.contentText);
  }
}

async function executeApproved(params: {
  executor: ToolExecutor;
  approvals: ToolApprovalStore;
  toolName: string;
  callId: string;
  arguments: Record<string, unknown>;
}): Promise<ToolExecutionResult> {
  const call = {
    id: `${params.callId}-denied`,
    name: params.toolName,
    arguments: params.arguments,
  };
  const denied = await params.executor.execute(call, {
    sessionKey: SESSION_KEY,
    requestedByUserId: ADMIN_USER_ID,
    chatId: "local-tool-validation",
  });
  if (!denied.isError || denied.errorCode !== "approval_required") {
    throw new Error(`Expected approval_required for ${params.toolName}, got ${denied.errorCode ?? "success"}.`);
  }
  params.approvals.approve({
    sessionKey: SESSION_KEY,
    toolName: params.toolName,
    approvedByUserId: ADMIN_USER_ID,
    reason: "local validation",
    ttlMs: 60_000,
    requestFingerprint: createToolRequestFingerprint({
      toolName: params.toolName,
      arguments: params.arguments,
    }),
  });
  const approved = await params.executor.execute(
    {
      id: params.callId,
      name: params.toolName,
      arguments: params.arguments,
    },
    {
      sessionKey: SESSION_KEY,
      requestedByUserId: ADMIN_USER_ID,
      chatId: "local-tool-validation",
    },
  );
  assertToolPassed(approved);
  return approved;
}

async function runScenarioOnce(
  name: string,
  run: () => Promise<Record<string, unknown> | undefined>,
): Promise<LocalToolScenarioResult> {
  try {
    const details = await run();
    return {
      name,
      status: "passed",
      ...(details ? { details } : {}),
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createLocalToolValidationSuiteResult(): Promise<LocalToolValidationSuiteResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mottbot-local-tools-"));
  const notesRoot = path.join(tempRoot, "notes");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const mcpServerPath = path.join(tempRoot, "echo-mcp.mjs");
  const databasePath = path.join(tempRoot, "validation.sqlite");
  fs.mkdirSync(notesRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  writeMcpEchoServer(mcpServerPath);

  const database = new DatabaseClient(databasePath);
  try {
    migrateDatabase(database);
    const clock = new SystemClock();
    new SessionStore(database, clock).ensure({
      sessionKey: SESSION_KEY,
      chatId: "local-tool-validation",
      userId: ADMIN_USER_ID,
      routeMode: "dm",
      profileId: "openai-codex:default",
      modelRef: "openai-codex/gpt-5.4",
    });
    const approvals = new ToolApprovalStore(database, clock);
    const executor = new ToolExecutor(createRuntimeToolRegistry({ enableSideEffectTools: true }), {
      clock,
      approvals,
      adminUserIds: [ADMIN_USER_ID],
      handlers: {
        ...createLocalWriteToolHandlers({
          roots: [notesRoot],
          deniedPaths: [],
          maxWriteBytes: 4_000,
        }),
        ...createLocalExecToolHandlers({
          roots: [workspaceRoot],
          deniedPaths: [],
          allowedCommands: [process.execPath],
          timeoutMs: 5_000,
          maxOutputBytes: 4_000,
        }),
        ...createMcpToolHandlers({
          servers: [
            {
              name: "validation",
              command: process.execPath,
              args: [mcpServerPath],
              allowedTools: ["echo"],
              timeoutMs: 5_000,
              maxOutputBytes: 4_000,
            },
          ],
        }),
      },
    });

    const scenarios: LocalToolScenarioResult[] = [];

    scenarios.push(
      await runScenarioOnce("local document read, append, and replace", async () => {
        const docPath = path.join(notesRoot, "plan.md");
        fs.writeFileSync(docPath, "one\n", "utf8");
        const initialRead = parseToolJson(
          await executor.execute(
            {
              id: "read-initial",
              name: "mottbot_local_doc_read",
              arguments: { path: "plan.md" },
            },
            {
              sessionKey: SESSION_KEY,
              requestedByUserId: ADMIN_USER_ID,
              chatId: "local-tool-validation",
            },
          ),
        );
        await executeApproved({
          executor,
          approvals,
          toolName: "mottbot_local_doc_append",
          callId: "append-doc",
          arguments: { path: "plan.md", content: "two\n" },
        });
        const afterAppend = parseToolJson(
          await executor.execute(
            {
              id: "read-after-append",
              name: "mottbot_local_doc_read",
              arguments: { path: "plan.md" },
            },
            {
              sessionKey: SESSION_KEY,
              requestedByUserId: ADMIN_USER_ID,
              chatId: "local-tool-validation",
            },
          ),
        );
        const sha256 = afterAppend.sha256;
        if (typeof sha256 !== "string") {
          throw new Error("Document read did not return SHA-256.");
        }
        await executeApproved({
          executor,
          approvals,
          toolName: "mottbot_local_doc_replace",
          callId: "replace-doc",
          arguments: { path: "plan.md", expectedSha256: sha256, content: "done\n" },
        });
        const finalText = fs.readFileSync(docPath, "utf8");
        if (finalText !== "done\n") {
          throw new Error(`Unexpected final document content: ${JSON.stringify(finalText)}.`);
        }
        return {
          initialBytes: initialRead.sizeBytes,
          appendedBytes: afterAppend.sizeBytes,
          finalBytes: Buffer.byteLength(finalText, "utf8"),
        };
      }),
    );

    scenarios.push(
      await runScenarioOnce("allowlisted local command execution", async () => {
        const result = parseToolJson(
          await executeApproved({
            executor,
            approvals,
            toolName: "mottbot_local_command_run",
            callId: "run-command",
            arguments: {
              command: process.execPath,
              args: ["-e", "process.stdout.write('local command ok')"],
            },
          }),
        );
        if (result.stdout !== "local command ok") {
          throw new Error(`Unexpected command stdout: ${JSON.stringify(result.stdout)}.`);
        }
        return {
          exitCode: result.exitCode,
          truncated: result.truncated,
        };
      }),
    );

    scenarios.push(
      await runScenarioOnce("configured MCP stdio tool call", async () => {
        const result = parseToolJson(
          await executeApproved({
            executor,
            approvals,
            toolName: "mottbot_mcp_call_tool",
            callId: "call-mcp",
            arguments: {
              server: "validation",
              tool: "echo",
              arguments: { text: "mcp ok" },
            },
          }),
        );
        const raw = JSON.stringify(result.result);
        if (!raw.includes("echo:mcp ok")) {
          throw new Error(`Unexpected MCP result: ${raw}.`);
        }
        return {
          server: result.server,
          tool: result.tool,
          truncated: result.truncated,
        };
      }),
    );

    const failed = scenarios.some((scenario) => scenario.status === "failed");
    return {
      status: failed ? "failed" : "passed",
      tempRoot,
      scenarios,
    };
  } finally {
    database.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await createLocalToolValidationSuiteResult();
  printJson({
    ...result,
    tempRoot: "[removed]",
  });
  process.exitCode = result.status === "passed" ? 0 : 1;
}

/* v8 ignore start */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    printJson({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}
/* v8 ignore stop */
