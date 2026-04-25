/** Category describing the side effects a tool may perform. */
export type ToolSideEffect =
  | "read_only"
  | "local_write"
  | "local_exec"
  | "network"
  | "network_write"
  | "telegram_send"
  | "github_write"
  | "process_control"
  | "secret_adjacent";

/** Primitive values supported in the local JSON schema subset. */
type ToolJsonPrimitive = string | number | boolean | null;

/** JSON schema subset used for model tool declarations and local validation. */
type ToolJsonSchema = {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  properties?: Record<string, ToolJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolJsonSchema;
  enum?: ToolJsonPrimitive[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};

/** Object schema required for every model-callable tool input. */
type ToolInputSchema = ToolJsonSchema & {
  type: "object";
};

/** Full local definition for a model-callable tool. */
export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  timeoutMs: number;
  maxOutputBytes: number;
  sideEffect: ToolSideEffect;
  enabled: boolean;
  requiresAdmin?: boolean;
};

/** Options controlling which tool definitions may be registered. */
type ToolRegistryOptions = {
  allowSideEffectDefinitions?: boolean;
};

/** Options controlling whether side-effecting tools may be resolved or validated. */
type ToolResolveOptions = {
  allowSideEffects?: boolean;
};

/** Provider-facing tool declaration exposed to a model. */
export type ModelToolDeclaration = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
};

/** OpenClaw-style selector group for related Mottbot tools. */
type ToolGroupName =
  | "runtime"
  | "fs"
  | "sessions"
  | "memory"
  | "web"
  | "ui"
  | "automation"
  | "messaging"
  | "agents"
  | "media"
  | "openclaw";

/** Filters applied when building provider-facing tool declarations. */
type ModelToolDeclarationOptions = {
  includeAdminTools?: boolean;
  filter?: (definition: ToolDefinition) => boolean;
};

/** Stable error codes returned by registry validation and lookup failures. */
type ToolRegistryErrorCode =
  | "invalid_definition"
  | "unknown_tool"
  | "disabled_tool"
  | "side_effect_not_allowed"
  | "invalid_input";

/** Error thrown when a tool definition, lookup, or input fails registry validation. */
export class ToolRegistryError extends Error {
  constructor(
    readonly code: ToolRegistryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_000_000;

/** Built-in tools that inspect local or remote state without side effects. */
const READ_ONLY_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "mottbot_health_snapshot",
    description: "Read a token-free Mottbot runtime health snapshot.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    maxOutputBytes: 8_000,
    sideEffect: "read_only",
    enabled: true,
  },
  {
    name: "mottbot_service_status",
    description: "Read the local Mottbot launchd service status without changing it.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 8_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_recent_runs",
    description: "List recent Mottbot run records from the local SQLite database.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "Maximum number of recent runs to return. Defaults to 10.",
        },
        sessionKey: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional session key filter.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 24_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_recent_errors",
    description: "Read recent failed or cancelled runs and recent stderr log lines.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of failed runs and stderr lines to return. Defaults to 10.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 32_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_recent_logs",
    description: "Read recent local Mottbot service log lines.",
    inputSchema: {
      type: "object",
      properties: {
        stream: {
          type: "string",
          enum: ["stdout", "stderr", "both"],
          description: "Which launchd log stream to read. Defaults to both.",
        },
        lines: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Number of lines per stream. Defaults to 40.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 48_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_repo_list_files",
    description: "List files under an approved local repository root without reading file contents.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional repository-relative directory path. Defaults to the root.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to list recursively. Defaults to false.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 300,
          description: "Maximum entries to return. Defaults to 100.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 48_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_repo_read_file",
    description: "Read a bounded text slice from an approved local repository file.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Repository-relative file path to read.",
        },
        startLine: {
          type: "integer",
          minimum: 1,
          description: "First 1-based line to return. Defaults to 1.",
        },
        maxLines: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum lines to return. Defaults to 200.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Maximum UTF-8 bytes to return, capped by host config.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 64_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_repo_search",
    description: "Search literal text in approved local repository files with bounded matches.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional repository-relative file or directory path. Defaults to the root.",
        },
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Literal text to search for.",
        },
        maxMatches: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum matches to return, capped by host config.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 500000,
          description: "Maximum UTF-8 bytes to return, capped by host config.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    maxOutputBytes: 96_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_git_status",
    description: "Read git branch and working-tree status for an approved local repository.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 24_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_git_branch",
    description: "Read the current branch or detached commit for an approved local repository.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 8_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_git_recent_commits",
    description: "Read recent git commit summaries for an approved local repository.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum commits to return. Defaults to 10.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 24_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_git_diff",
    description: "Read a bounded git diff summary or a selected approved file diff.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional repository-relative file path for a content diff. Omit for diff stat and summary only.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 500000,
          description: "Maximum UTF-8 bytes to return, capped by host config.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    maxOutputBytes: 96_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_github_repo",
    description: "Read GitHub repository metadata through the host GitHub CLI.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional GitHub repository in owner/name form. Defaults to configured or local origin repository.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 24_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_github_open_prs",
    description: "Read open GitHub pull requests through the host GitHub CLI.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional GitHub repository in owner/name form. Defaults to configured or local origin repository.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum pull requests to return. Defaults to host config.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_github_recent_issues",
    description: "Read recent open GitHub issues through the host GitHub CLI.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional GitHub repository in owner/name form. Defaults to configured or local origin repository.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum issues to return. Defaults to host config.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_github_ci_status",
    description: "Read recent GitHub Actions workflow runs through the host GitHub CLI.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional GitHub repository in owner/name form. Defaults to configured or local origin repository.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum workflow runs to return. Defaults to host config.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 96_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_github_workflow_failures",
    description: "Read recent failed GitHub Actions workflow runs through the host GitHub CLI.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional GitHub repository in owner/name form. Defaults to configured or local origin repository.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum failed workflow runs to return. Defaults to host config.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 96_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_ms_todo_lists",
    description: "Read Microsoft To Do task lists through Microsoft Graph using the configured delegated access token.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum lists to return. Defaults to host config.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_ms_todo_tasks",
    description:
      "Read Microsoft To Do tasks for a specific list through Microsoft Graph using the configured delegated access token.",
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional Microsoft To Do list id. Defaults to configured list id.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum tasks to return. Defaults to host config.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 96_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_ms_todo_task_get",
    description: "Read one Microsoft To Do task by list and task id through Microsoft Graph.",
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional Microsoft To Do list id. Defaults to configured list id.",
        },
        taskId: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Microsoft To Do task id.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 64_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_google_drive_search",
    description: "Search Google Drive files using the configured delegated access token.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional full-text query. Defaults to recently modified non-trashed files.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum file summaries to return. Defaults to host config.",
        },
        includeTrashed: {
          type: "boolean",
          description: "Whether trashed files may be included. Defaults to false.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 96_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_google_drive_get_file",
    description: "Read Google Drive file metadata and optionally inline textual document content.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Google Drive file id.",
        },
        includeContent: {
          type: "boolean",
          description: "When true, also fetch inline text content for supported file types.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 500000,
          description: "Optional UTF-8 byte limit for inline text content, capped by host config.",
        },
      },
      required: ["fileId"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 160_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_local_doc_read",
    description:
      "Read a bounded Markdown or text document from an approved local-write root and return its SHA-256 for safe edits.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved local-write root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "Approved-root-relative existing .md or .txt path to read.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Maximum UTF-8 bytes to return, capped by host config.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 120_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_codex_job_status",
    description: "Read status and artifact paths for a Codex CLI job started by this Mottbot process.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Codex CLI job id returned by mottbot_codex_job_start.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 32_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_codex_job_tail",
    description: "Read recent JSONL events for a Codex CLI job started by this Mottbot process.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Codex CLI job id returned by mottbot_codex_job_start.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum recent events to return. Defaults to 20.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 96_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_process_list",
    description: "Read a bounded local process list without changing any process.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum processes to return. Defaults to 25.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 64_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_sessions_list",
    description: "Read recent Mottbot session routes.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum sessions to return. Defaults to 10.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 48_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_session_history",
    description: "Read bounded transcript history for one Mottbot session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionKey: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Session key to inspect.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum transcript rows to return. Defaults to 10.",
        },
      },
      required: ["sessionKey"],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 96_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_tool_catalog",
    description: "Read the current Mottbot tool catalog, groups, side effects, and enabled state.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: {
          type: "boolean",
          description: "Whether to include descriptions and schemas. Defaults to false.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 1_000,
    maxOutputBytes: 120_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_extension_catalog",
    description: "Read configured local extension, plugin, skill, and MCP manifest hints.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 48_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_extension_manifest_read",
    description: "Read a bounded local extension manifest from an approved repository root.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Repository-relative JSON or Markdown manifest path.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Maximum UTF-8 bytes to return, capped by host config.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 120_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
  {
    name: "mottbot_automation_tasks",
    description: "Read local automation task artifacts created by Mottbot tools.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum task artifacts to return. Defaults to 10.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 64_000,
    sideEffect: "read_only",
    enabled: true,
    requiresAdmin: true,
  },
] as const;

/** Built-in tools that can write, call external APIs, or control local processes. */
const SIDE_EFFECT_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "mottbot_codex_job_start",
    description:
      "Start a non-interactive Codex CLI job in an approved project repository after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved project repository root label or path. Required only when multiple roots are configured.",
        },
        cwd: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional approved-root-relative working directory. Defaults to the selected repository root.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "Prompt passed to codex exec.",
        },
        profile: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional Codex CLI profile. Defaults to codexJobs.codex.coderProfile.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 30000,
          maximum: 86400000,
          description: "Optional timeout capped by codexJobs.codex.defaultTimeoutMs.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
    sideEffect: "local_exec",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_codex_job_cancel",
    description: "Cancel a running Codex CLI job started by this Mottbot process after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Codex CLI job id returned by mottbot_codex_job_start.",
        },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    timeoutMs: 2_000,
    maxOutputBytes: 32_000,
    sideEffect: "process_control",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_local_note_create",
    description:
      "Create a new Markdown or text note in an approved local notes directory after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved local-write root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "Approved-root-relative .md or .txt path to create. Existing files are never overwritten.",
        },
        content: {
          type: "string",
          minLength: 1,
          maxLength: 40000,
          description: "Plain text content to write, capped again by host config.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 12_000,
    sideEffect: "local_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_local_doc_append",
    description:
      "Append plain text to an existing Markdown or text document under an approved local-write root after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved local-write root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "Approved-root-relative existing .md or .txt path to append to.",
        },
        content: {
          type: "string",
          minLength: 1,
          maxLength: 40000,
          description: "Plain text content to append, capped again by host config.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 12_000,
    sideEffect: "local_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_local_doc_replace",
    description:
      "Replace an existing Markdown or text document under an approved local-write root after explicit operator approval and SHA-256 match.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved local-write root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 300,
          description: "Approved-root-relative existing .md or .txt path to replace.",
        },
        expectedSha256: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          description: "SHA-256 of the current file content, usually obtained from a prior document read.",
        },
        content: {
          type: "string",
          minLength: 1,
          maxLength: 40000,
          description: "Replacement plain text content, capped again by host config.",
        },
      },
      required: ["path", "expectedSha256", "content"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 12_000,
    sideEffect: "local_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_local_command_run",
    description: "Run one configured local command in an approved working directory after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved execution root label or path. Required only when multiple roots are configured.",
        },
        cwd: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional root-relative working directory. Defaults to the selected root.",
        },
        command: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Executable name or configured command path that must appear in the host allowlist.",
        },
        args: {
          type: "array",
          description: "Command arguments. Shell syntax is not supported.",
          items: {
            type: "string",
            maxLength: 500,
          },
        },
        timeoutMs: {
          type: "integer",
          minimum: 100,
          maximum: 30000,
          description: "Optional timeout capped by host config.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    maxOutputBytes: 120_000,
    sideEffect: "local_exec",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_repo_apply_patch",
    description: "Apply a git patch inside an approved repository root after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
        patch: {
          type: "string",
          minLength: 1,
          maxLength: 120000,
          description: "Git apply compatible patch text. Denied paths and path escapes are rejected before apply.",
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 120_000,
    sideEffect: "local_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_local_shell_run",
    description:
      "Run a bounded shell script in an approved working directory after explicit operator approval and shell allowlist opt-in.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved execution root label or path. Required only when multiple roots are configured.",
        },
        cwd: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional root-relative working directory. Defaults to the selected root.",
        },
        script: {
          type: "string",
          minLength: 1,
          maxLength: 12000,
          description: "Shell script passed to the configured system shell with no interactive stdin.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 100,
          maximum: 30000,
          description: "Optional timeout capped by host config.",
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    maxOutputBytes: 120_000,
    sideEffect: "local_exec",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_code_execution_run",
    description:
      "Run bounded JavaScript through the allowlisted local Node executable after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved execution root label or path. Required only when multiple roots are configured.",
        },
        cwd: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional root-relative working directory. Defaults to the selected root.",
        },
        code: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "JavaScript source run as an ESM stdin module.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 100,
          maximum: 30000,
          description: "Optional timeout capped by host config.",
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    maxOutputBytes: 120_000,
    sideEffect: "local_exec",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_web_fetch",
    description: "Fetch bounded text from a public HTTP(S) URL after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "Public http or https URL to fetch.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Maximum response bytes to return.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 200_000,
    sideEffect: "network",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_web_search",
    description: "Search the public web through a bounded HTML search endpoint after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Search query.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Maximum search results to return. Defaults to 5.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 120_000,
    sideEffect: "network",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_browser_snapshot",
    description: "Fetch a public page and return browser-like title and text metadata after explicit approval.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "Public http or https URL to inspect.",
        },
        maxBytes: {
          type: "integer",
          minimum: 1,
          maximum: 200000,
          description: "Maximum response bytes to inspect.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 160_000,
    sideEffect: "network",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_canvas_create",
    description: "Create a bounded local HTML canvas artifact under data/tool-canvas after explicit approval.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Canvas artifact title.",
        },
        body: {
          type: "string",
          minLength: 1,
          maxLength: 40000,
          description: "Plain text or HTML body for the local canvas artifact.",
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 24_000,
    sideEffect: "local_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_subagent_codex_start",
    description: "Start a Codex CLI subagent job in an approved project repository after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Optional approved project repository root label or path. Required only when multiple roots are configured.",
        },
        cwd: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional approved-root-relative working directory. Defaults to the selected repository root.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "Prompt passed to codex exec.",
        },
        profile: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional Codex CLI profile. Defaults to codexJobs.codex.coderProfile.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 30000,
          maximum: 86400000,
          description: "Optional timeout capped by codexJobs.codex.defaultTimeoutMs.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
    sideEffect: "local_exec",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_automation_task_create",
    description: "Create a local automation task artifact under data/tool-automation after explicit approval.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Task title.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "Task prompt or instructions.",
        },
        schedule: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional human-readable or cron-like schedule string.",
        },
      },
      required: ["title", "prompt"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 24_000,
    sideEffect: "local_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_gateway_webhook_post",
    description: "POST a bounded JSON payload to a public webhook URL after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "Public http or https webhook URL.",
        },
        payload: {
          type: "object",
          description: "JSON object payload.",
          additionalProperties: true,
        },
      },
      required: ["url", "payload"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 80_000,
    sideEffect: "network_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_media_artifact_create",
    description: "Create a local media-generation request artifact after explicit approval.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["image", "audio", "video", "tts"],
          description: "Requested media artifact kind.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "Generation prompt or narration text.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Optional artifact title.",
        },
      },
      required: ["kind", "prompt"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 24_000,
    sideEffect: "local_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_mcp_call_tool",
    description: "Call one allowlisted tool on one configured MCP stdio server after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        server: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "Configured MCP server name.",
        },
        tool: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Allowlisted MCP tool name.",
        },
        arguments: {
          type: "object",
          description: "MCP tool arguments.",
          additionalProperties: true,
        },
      },
      required: ["server", "tool", "arguments"],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    maxOutputBytes: 120_000,
    sideEffect: "network_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_ms_todo_task_create",
    description:
      "Create a Microsoft To Do task in a selected list through Microsoft Graph after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional Microsoft To Do list id. Defaults to configured list id.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Task title.",
        },
        body: {
          type: "string",
          maxLength: 5000,
          description: "Optional plain-text task note body.",
        },
        dueDateTime: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional UTC due date-time in ISO-8601 format.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 24_000,
    sideEffect: "network_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_ms_todo_task_update",
    description: "Modify a Microsoft To Do task through Microsoft Graph after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        listId: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional Microsoft To Do list id. Defaults to configured list id.",
        },
        taskId: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Microsoft To Do task id.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional replacement task title.",
        },
        body: {
          type: "string",
          maxLength: 5000,
          description: "Optional replacement plain-text task note body.",
        },
        status: {
          type: "string",
          enum: ["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"],
          description: "Optional task status update.",
        },
        importance: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Optional task importance update.",
        },
        dueDateTime: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional UTC due date-time in ISO-8601 format.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 24_000,
    sideEffect: "network_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_github_issue_create",
    description: "Create a GitHub issue through the host GitHub CLI after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional GitHub repository in owner/name form. Defaults to configured or local origin repository.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Issue title.",
        },
        body: {
          type: "string",
          maxLength: 20000,
          description: "Optional Markdown issue body.",
        },
        labels: {
          type: "array",
          description: "Optional issue labels by name.",
          items: {
            type: "string",
            minLength: 1,
            maxLength: 80,
          },
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 16_000,
    sideEffect: "github_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_github_issue_comment",
    description: "Comment on a GitHub issue through the host GitHub CLI after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional GitHub repository in owner/name form. Defaults to configured or local origin repository.",
        },
        number: {
          type: "integer",
          minimum: 1,
          maximum: 10000000,
          description: "Issue number.",
        },
        body: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "Markdown comment body.",
        },
      },
      required: ["number", "body"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 16_000,
    sideEffect: "github_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_github_pr_comment",
    description: "Comment on a GitHub pull request through the host GitHub CLI after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        repository: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Optional GitHub repository in owner/name form. Defaults to configured or local origin repository.",
        },
        number: {
          type: "integer",
          minimum: 1,
          maximum: 10000000,
          description: "Pull request number.",
        },
        body: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "Markdown comment body.",
        },
      },
      required: ["number", "body"],
      additionalProperties: false,
    },
    timeoutMs: 15_000,
    maxOutputBytes: 16_000,
    sideEffect: "github_write",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_telegram_send_message",
    description:
      "Send a plain-text Telegram message to the current chat or a configured approved chat after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Optional Telegram chat ID or username. Defaults to the current chat.",
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Plain text message body. Formatting modes are intentionally not supported.",
        },
        replyToMessageId: {
          type: "integer",
          minimum: 1,
          description: "Optional message ID to reply to in the target chat.",
        },
        disableNotification: {
          type: "boolean",
          description: "Whether Telegram should send the message silently.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    timeoutMs: 5_000,
    maxOutputBytes: 8_000,
    sideEffect: "telegram_send",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_restart_service",
    description: "Restart the local Mottbot service after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 500,
        },
        delaySeconds: {
          type: "integer",
          minimum: 10,
          maximum: 300,
          description: "Optional delay before restart. Defaults to the configured safe delay.",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    timeoutMs: 10_000,
    maxOutputBytes: 8_000,
    sideEffect: "process_control",
    enabled: false,
    requiresAdmin: true,
  },
  {
    name: "mottbot_telegram_react",
    description: "Add or clear a Telegram emoji reaction after explicit operator approval.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Telegram chat ID or username target.",
        },
        messageId: {
          type: "integer",
          minimum: 1,
          description: "Telegram message ID to react to.",
        },
        emoji: {
          type: "string",
          maxLength: 32,
          description: "Unicode emoji to set. Use an empty string to clear the bot's reaction.",
        },
        isBig: {
          type: "boolean",
          description: "Optional Telegram large-reaction animation flag.",
        },
      },
      required: ["chatId", "messageId", "emoji"],
      additionalProperties: false,
    },
    timeoutMs: 3_000,
    maxOutputBytes: 8_000,
    sideEffect: "telegram_send",
    enabled: false,
    requiresAdmin: true,
  },
] as const;

/** Default full tool catalog before runtime side-effect filtering. */
const DEFAULT_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  ...READ_ONLY_TOOL_DEFINITIONS,
  ...SIDE_EFFECT_TOOL_DEFINITIONS,
] as const;

/** Built-in tool groups usable in agent allow-lists and discovery output. */
export const TOOL_GROUPS: Readonly<Record<ToolGroupName, readonly string[]>> = {
  runtime: [
    "mottbot_process_list",
    "mottbot_local_command_run",
    "mottbot_local_shell_run",
    "mottbot_code_execution_run",
    "mottbot_codex_job_start",
    "mottbot_codex_job_status",
    "mottbot_codex_job_tail",
    "mottbot_codex_job_cancel",
  ],
  fs: [
    "mottbot_repo_list_files",
    "mottbot_repo_read_file",
    "mottbot_repo_search",
    "mottbot_git_status",
    "mottbot_git_branch",
    "mottbot_git_recent_commits",
    "mottbot_git_diff",
    "mottbot_local_doc_read",
    "mottbot_local_note_create",
    "mottbot_local_doc_append",
    "mottbot_local_doc_replace",
    "mottbot_repo_apply_patch",
  ],
  sessions: ["mottbot_sessions_list", "mottbot_session_history", "mottbot_subagent_codex_start"],
  memory: ["mottbot_local_doc_read"],
  web: ["mottbot_web_fetch", "mottbot_web_search", "mottbot_browser_snapshot"],
  ui: ["mottbot_browser_snapshot", "mottbot_canvas_create"],
  automation: ["mottbot_automation_tasks", "mottbot_automation_task_create", "mottbot_gateway_webhook_post"],
  messaging: ["mottbot_telegram_send_message", "mottbot_telegram_react"],
  agents: ["mottbot_tool_catalog", "mottbot_sessions_list", "mottbot_session_history", "mottbot_subagent_codex_start"],
  media: ["mottbot_media_artifact_create"],
  openclaw: DEFAULT_TOOL_DEFINITIONS.map((definition) => definition.name),
};

/** Returns true when a selector targets a named OpenClaw-style tool group. */
export function isToolGroupSelector(selector: string): selector is `group:${ToolGroupName}` {
  const name = selector.startsWith("group:") ? selector.slice("group:".length) : "";
  return Object.prototype.hasOwnProperty.call(TOOL_GROUPS, name);
}

function toolMatchesSelector(definition: ToolDefinition, selector: string): boolean {
  return toolNameMatchesSelector(definition.name, selector);
}

/** Checks whether a tool name matches an exact tool name or group selector. */
export function toolNameMatchesSelector(toolName: string, selector: string): boolean {
  if (isToolGroupSelector(selector)) {
    const groupName = selector.slice("group:".length) as ToolGroupName;
    return TOOL_GROUPS[groupName].includes(toolName);
  }
  return toolName === selector;
}

/** Checks whether a tool definition matches any selector, treating an empty selector list as unrestricted. */
export function toolMatchesAnySelector(definition: ToolDefinition, selectors: readonly string[] | undefined): boolean {
  return (
    !selectors || selectors.length === 0 || selectors.some((selector) => toolMatchesSelector(definition, selector))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertValidDefinition(definition: ToolDefinition, options: ToolRegistryOptions): void {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new ToolRegistryError(
      "invalid_definition",
      `Invalid tool name ${definition.name}. Use 1-64 letters, numbers, underscores, or hyphens, starting with a letter.`,
    );
  }
  if (!definition.description.trim()) {
    throw new ToolRegistryError("invalid_definition", `Tool ${definition.name} requires a description.`);
  }
  if (definition.inputSchema.type !== "object") {
    throw new ToolRegistryError("invalid_definition", `Tool ${definition.name} input schema must be an object.`);
  }
  if (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > MAX_TIMEOUT_MS) {
    throw new ToolRegistryError(
      "invalid_definition",
      `Tool ${definition.name} timeout must be between 1 and ${MAX_TIMEOUT_MS} ms.`,
    );
  }
  if (
    !Number.isInteger(definition.maxOutputBytes) ||
    definition.maxOutputBytes < 1 ||
    definition.maxOutputBytes > MAX_OUTPUT_BYTES
  ) {
    throw new ToolRegistryError(
      "invalid_definition",
      `Tool ${definition.name} max output must be between 1 and ${MAX_OUTPUT_BYTES} bytes.`,
    );
  }
  if (definition.enabled && definition.sideEffect !== "read_only" && options.allowSideEffectDefinitions !== true) {
    throw new ToolRegistryError(
      "side_effect_not_allowed",
      `Tool ${definition.name} has side effect ${definition.sideEffect} and must stay disabled.`,
    );
  }
}

function matchesEnum(schema: ToolJsonSchema, value: unknown): boolean {
  return schema.enum ? schema.enum.some((item) => item === value) : true;
}

function validateAgainstSchema(schema: ToolJsonSchema, value: unknown, path: string): string[] {
  if (!matchesEnum(schema, value)) {
    return [`${path} must be one of ${schema.enum?.map((item) => JSON.stringify(item)).join(", ")}.`];
  }

  switch (schema.type) {
    case "object": {
      if (!isRecord(value)) {
        return [`${path} must be an object.`];
      }
      const properties = schema.properties ?? {};
      const required = schema.required ?? [];
      const errors: string[] = [];
      for (const key of required) {
        if (!(key in value)) {
          errors.push(`${path}.${key} is required.`);
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            errors.push(`${path}.${key} is not allowed.`);
          }
        }
      }
      for (const [key, childSchema] of Object.entries(properties)) {
        if (key in value) {
          errors.push(...validateAgainstSchema(childSchema, value[key], `${path}.${key}`));
        }
      }
      return errors;
    }
    case "string": {
      if (typeof value !== "string") {
        return [`${path} must be a string.`];
      }
      const errors: string[] = [];
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        errors.push(`${path} must be at least ${schema.minLength} characters.`);
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
        errors.push(`${path} must be at most ${schema.maxLength} characters.`);
      }
      return errors;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return [`${path} must be a ${schema.type}.`];
      }
      const errors: string[] = [];
      if (schema.type === "integer" && !Number.isInteger(value)) {
        errors.push(`${path} must be an integer.`);
      }
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        errors.push(`${path} must be at least ${schema.minimum}.`);
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        errors.push(`${path} must be at most ${schema.maximum}.`);
      }
      return errors;
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean.`];
    case "array": {
      if (!Array.isArray(value)) {
        return [`${path} must be an array.`];
      }
      const itemSchema = schema.items;
      return itemSchema
        ? value.flatMap((item, index) => validateAgainstSchema(itemSchema, item, `${path}[${index}]`))
        : [];
    }
    case "null":
      return value === null ? [] : [`${path} must be null.`];
  }
}

/** Validates tool definitions and produces safe model declarations and runtime inputs. */
export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  constructor(definitions: readonly ToolDefinition[] = DEFAULT_TOOL_DEFINITIONS, options: ToolRegistryOptions = {}) {
    for (const definition of definitions) {
      assertValidDefinition(definition, options);
      if (this.definitions.has(definition.name)) {
        throw new ToolRegistryError("invalid_definition", `Duplicate tool definition ${definition.name}.`);
      }
      this.definitions.set(definition.name, definition);
    }
  }

  listAll(): ToolDefinition[] {
    return [...this.definitions.values()];
  }

  listEnabled(): ToolDefinition[] {
    return [...this.definitions.values()].filter((definition) => definition.enabled);
  }

  listModelDeclarations(options: ModelToolDeclarationOptions = {}): ModelToolDeclaration[] {
    return this.listEnabled()
      .filter((definition) => options.includeAdminTools === true || definition.requiresAdmin !== true)
      .filter((definition) => options.filter?.(definition) ?? true)
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      }));
  }

  resolve(name: string, options: ToolResolveOptions = {}): ToolDefinition {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new ToolRegistryError("unknown_tool", `Unknown tool ${name}.`);
    }
    if (!definition.enabled) {
      throw new ToolRegistryError("disabled_tool", `Tool ${name} is disabled.`);
    }
    if (definition.sideEffect !== "read_only" && options.allowSideEffects !== true) {
      throw new ToolRegistryError(
        "side_effect_not_allowed",
        `Tool ${name} has side effect ${definition.sideEffect} and cannot be executed.`,
      );
    }
    return definition;
  }

  validateInput(name: string, input: unknown, options: ToolResolveOptions = {}): Record<string, unknown> {
    const definition = this.resolve(name, options);
    const errors = validateAgainstSchema(definition.inputSchema, input, "$");
    if (errors.length > 0) {
      throw new ToolRegistryError("invalid_input", `Invalid input for ${name}: ${errors.join(" ")}`);
    }
    return input as Record<string, unknown>;
  }
}

/** Creates a registry with the default catalog and default side-effect restrictions. */
export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(DEFAULT_TOOL_DEFINITIONS);
}

/** Creates the runtime registry with side-effect tools enabled only when configured. */
export function createRuntimeToolRegistry(params: { enableSideEffectTools: boolean }): ToolRegistry {
  const definitions = [
    ...READ_ONLY_TOOL_DEFINITIONS,
    ...SIDE_EFFECT_TOOL_DEFINITIONS.map((definition) => ({
      ...definition,
      enabled: params.enableSideEffectTools,
    })),
  ];
  return new ToolRegistry(definitions, {
    allowSideEffectDefinitions: params.enableSideEffectTools,
  });
}
