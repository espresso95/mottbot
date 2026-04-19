export type ToolSideEffect = "read_only" | "local_write" | "network" | "process_control" | "secret_adjacent";

export type ToolJsonPrimitive = string | number | boolean | null;

export type ToolJsonSchema = {
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

export type ToolInputSchema = ToolJsonSchema & {
  type: "object";
};

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

export type ToolRegistryOptions = {
  allowSideEffectDefinitions?: boolean;
};

export type ToolResolveOptions = {
  allowSideEffects?: boolean;
};

export type ModelToolDeclaration = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
};

export type ModelToolDeclarationOptions = {
  includeAdminTools?: boolean;
  filter?: (definition: ToolDefinition) => boolean;
};

export type ToolRegistryErrorCode =
  | "invalid_definition"
  | "unknown_tool"
  | "disabled_tool"
  | "side_effect_not_allowed"
  | "invalid_input";

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

export const READ_ONLY_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
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
          description: "Optional approved repository root label or path. Required only when multiple roots are configured.",
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
          description: "Optional approved repository root label or path. Required only when multiple roots are configured.",
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
          description: "Optional approved repository root label or path. Required only when multiple roots are configured.",
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
          description: "Optional approved repository root label or path. Required only when multiple roots are configured.",
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
          description: "Optional approved repository root label or path. Required only when multiple roots are configured.",
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
          description: "Optional approved repository root label or path. Required only when multiple roots are configured.",
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
          description: "Optional approved repository root label or path. Required only when multiple roots are configured.",
        },
        path: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Optional repository-relative file path for a content diff. Omit for diff stat and summary only.",
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
] as const;

export const SIDE_EFFECT_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
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
    sideEffect: "network",
    enabled: false,
    requiresAdmin: true,
  },
] as const;

export const DEFAULT_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  ...READ_ONLY_TOOL_DEFINITIONS,
  ...SIDE_EFFECT_TOOL_DEFINITIONS,
] as const;

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
  if (
    definition.enabled &&
    definition.sideEffect !== "read_only" &&
    options.allowSideEffectDefinitions !== true
  ) {
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

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  constructor(
    definitions: readonly ToolDefinition[] = DEFAULT_TOOL_DEFINITIONS,
    options: ToolRegistryOptions = {},
  ) {
    for (const definition of definitions) {
      assertValidDefinition(definition, options);
      if (this.definitions.has(definition.name)) {
        throw new ToolRegistryError("invalid_definition", `Duplicate tool definition ${definition.name}.`);
      }
      this.definitions.set(definition.name, definition);
    }
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

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry(DEFAULT_TOOL_DEFINITIONS);
}

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
