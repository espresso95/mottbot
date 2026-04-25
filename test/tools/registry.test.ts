import { describe, expect, it } from "vitest";
import {
  createDefaultToolRegistry,
  createRuntimeToolRegistry,
  ToolRegistry,
  ToolRegistryError,
  type ToolDefinition,
} from "../../src/tools/registry.js";

function readOnlyTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "lookup_value",
    description: "Lookup a test value.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          minLength: 1,
          maxLength: 20,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["key"],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    maxOutputBytes: 4_000,
    sideEffect: "read_only",
    enabled: true,
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  it("exposes only non-admin enabled read-only model declarations by default", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.listModelDeclarations().map((tool) => tool.name)).toEqual(["mottbot_health_snapshot"]);
  });

  it("includes admin-only model declarations when requested", () => {
    const registry = createDefaultToolRegistry();

    expect(registry.listModelDeclarations({ includeAdminTools: true }).map((tool) => tool.name)).toEqual([
      "mottbot_health_snapshot",
      "mottbot_service_status",
      "mottbot_recent_runs",
      "mottbot_recent_errors",
      "mottbot_recent_logs",
      "mottbot_repo_list_files",
      "mottbot_repo_read_file",
      "mottbot_repo_search",
      "mottbot_git_status",
      "mottbot_git_branch",
      "mottbot_git_recent_commits",
      "mottbot_git_diff",
      "mottbot_github_repo",
      "mottbot_github_open_prs",
      "mottbot_github_recent_issues",
      "mottbot_github_ci_status",
      "mottbot_github_workflow_failures",
      "mottbot_ms_todo_lists",
      "mottbot_ms_todo_tasks",
      "mottbot_ms_todo_task_get",
      "mottbot_google_drive_search",
      "mottbot_google_drive_get_file",
      "mottbot_local_doc_read",
      "mottbot_codex_job_status",
      "mottbot_codex_job_tail",
    ]);
  });

  it("filters model declarations with caller policy", () => {
    const registry = new ToolRegistry([readOnlyTool({ name: "lookup_value" }), readOnlyTool({ name: "hidden_value" })]);

    expect(
      registry
        .listModelDeclarations({
          filter: (definition) => definition.name !== "hidden_value",
        })
        .map((tool) => tool.name),
    ).toEqual(["lookup_value"]);
  });

  it("rejects unknown and disabled tools", () => {
    const registry = createDefaultToolRegistry();

    expect(() => registry.resolve("missing_tool")).toThrow(ToolRegistryError);
    expect(() => registry.resolve("mottbot_restart_service")).toThrow("disabled");
  });

  it("validates tool input against the declared schema", () => {
    const registry = new ToolRegistry([readOnlyTool()]);

    expect(registry.validateInput("lookup_value", { key: "abc", limit: 3 })).toEqual({ key: "abc", limit: 3 });
    expect(() => registry.validateInput("lookup_value", { limit: 3 })).toThrow("$.key is required");
    expect(() => registry.validateInput("lookup_value", { key: "abc", extra: true })).toThrow("$.extra is not allowed");
    expect(() => registry.validateInput("lookup_value", { key: "abc", limit: 1.5 })).toThrow(
      "$.limit must be an integer",
    );
  });

  it("requires enabled tools to be read-only", () => {
    expect(
      () =>
        new ToolRegistry([
          readOnlyTool({
            sideEffect: "process_control",
          }),
        ]),
    ).toThrow("must stay disabled");
  });

  it("can expose side-effecting tools only when explicitly configured", () => {
    const registry = new ToolRegistry(
      [
        readOnlyTool({
          sideEffect: "process_control",
        }),
      ],
      { allowSideEffectDefinitions: true },
    );

    expect(registry.listModelDeclarations()).toEqual([expect.objectContaining({ name: "lookup_value" })]);
    expect(() => registry.resolve("lookup_value")).toThrow("side effect process_control");
    expect(registry.resolve("lookup_value", { allowSideEffects: true })).toMatchObject({
      sideEffect: "process_control",
    });
  });

  it("enables the reserved restart tool only through the runtime registry factory", () => {
    const registry = createDefaultToolRegistry();
    const runtimeRegistry = createRuntimeToolRegistry({ enableSideEffectTools: true });
    const sideEffectToolNames = runtimeRegistry
      .listModelDeclarations({ includeAdminTools: true })
      .map((tool) => tool.name);

    expect(registry.listModelDeclarations().map((tool) => tool.name)).not.toContain("mottbot_restart_service");
    expect(runtimeRegistry.listModelDeclarations().map((tool) => tool.name)).not.toContain("mottbot_restart_service");
    expect(sideEffectToolNames).toEqual(
      expect.arrayContaining([
        "mottbot_local_note_create",
        "mottbot_local_doc_append",
        "mottbot_local_doc_replace",
        "mottbot_local_command_run",
        "mottbot_codex_job_start",
        "mottbot_codex_job_cancel",
        "mottbot_mcp_call_tool",
        "mottbot_github_issue_create",
        "mottbot_github_issue_comment",
        "mottbot_github_pr_comment",
        "mottbot_ms_todo_task_create",
        "mottbot_ms_todo_task_update",
        "mottbot_telegram_send_message",
        "mottbot_restart_service",
        "mottbot_telegram_react",
      ]),
    );
  });

  it("accepts disabled side-effecting tool definitions without exposing them", () => {
    const registry = new ToolRegistry([
      readOnlyTool(),
      readOnlyTool({
        name: "restart_service",
        description: "Restart the service.",
        sideEffect: "process_control",
        enabled: false,
      }),
    ]);

    expect(registry.listEnabled().map((definition) => definition.name)).toEqual(["lookup_value"]);
    expect(() => registry.resolve("restart_service")).toThrow("disabled");
  });

  it("rejects malformed tool definitions", () => {
    expect(() => new ToolRegistry([readOnlyTool({ name: "bad.name" })])).toThrow("Invalid tool name");
    expect(() => new ToolRegistry([readOnlyTool({ timeoutMs: 0 })])).toThrow("timeout");
    expect(() => new ToolRegistry([readOnlyTool(), readOnlyTool()])).toThrow("Duplicate");
  });
});
