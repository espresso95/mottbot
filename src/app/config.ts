import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { fileExists } from "../shared/fs.js";

const transportSchema = z.enum(["auto", "sse", "websocket"]);
const telegramReactionNotificationsSchema = z.enum(["off", "own", "all"]);
const toolCallerRoleSchema = z.enum(["owner", "admin", "trusted", "user"]);
const toolPolicyConfigSchema = z.object({
  allowedRoles: z.array(toolCallerRoleSchema).optional(),
  allowedChatIds: z.array(z.string()).optional(),
  requiresApproval: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  maxOutputBytes: z.number().int().min(1).optional(),
});
const telegramChatTypeSchema = z.enum(["private", "group", "supergroup", "channel"]);
const agentIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const agentConfigSchema = z.object({
  id: agentIdSchema,
  displayName: z.string().min(1).max(100).optional(),
  profileId: z.string().min(1).max(100).optional(),
  modelRef: z.string().min(1).max(200).optional(),
  systemPrompt: z.string().min(1).max(8000).optional(),
  fastMode: z.boolean().optional(),
  toolNames: z.array(z.string().min(1).max(128)).optional(),
  toolPolicies: z.record(toolPolicyConfigSchema).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(32).optional(),
  maxQueuedRuns: z.number().int().min(0).max(1000).optional(),
});
const agentRoutingBindingSchema = z.object({
  agentId: agentIdSchema,
  chatId: z.string().min(1).max(128).optional(),
  threadId: z.number().int().min(1).optional(),
  chatType: telegramChatTypeSchema.optional(),
  userId: z.string().min(1).max(128).optional(),
});
const agentsConfigSchema = z
  .object({
    defaultId: agentIdSchema.default("main"),
    list: z.array(agentConfigSchema).default([]),
    bindings: z.array(agentRoutingBindingSchema).default([]),
  })
  .default({});
const usageBudgetConfigSchema = z
  .object({
    dailyRuns: z.number().int().min(0).default(0),
    dailyRunsPerUser: z.number().int().min(0).default(0),
    dailyRunsPerChat: z.number().int().min(0).default(0),
    dailyRunsPerSession: z.number().int().min(0).default(0),
    dailyRunsPerModel: z.number().int().min(0).default(0),
    monthlyRuns: z.number().int().min(0).default(0),
    monthlyRunsPerUser: z.number().int().min(0).default(0),
    monthlyRunsPerChat: z.number().int().min(0).default(0),
    monthlyRunsPerSession: z.number().int().min(0).default(0),
    monthlyRunsPerModel: z.number().int().min(0).default(0),
    warningThresholdPercent: z.number().int().min(1).max(100).default(80),
  })
  .default({});
const repositoryToolConfigSchema = z
  .object({
    roots: z.array(z.string()).default(["."]),
    deniedPaths: z.array(z.string()).default([]),
    maxReadBytes: z.number().int().min(1).max(200_000).default(40_000),
    maxSearchMatches: z.number().int().min(1).max(500).default(100),
    maxSearchBytes: z.number().int().min(1).max(500_000).default(80_000),
    commandTimeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  })
  .default({});
const localWriteToolConfigSchema = z
  .object({
    roots: z.array(z.string()).default(["./data/tool-notes"]),
    deniedPaths: z.array(z.string()).default([]),
    maxWriteBytes: z.number().int().min(1).max(200_000).default(20_000),
  })
  .default({});
const localExecToolConfigSchema = z
  .object({
    roots: z.array(z.string()).default(["./data/tool-workspace"]),
    deniedPaths: z.array(z.string()).default([]),
    allowedCommands: z.array(z.string()).default([]),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    maxOutputBytes: z.number().int().min(1).max(200_000).default(40_000),
  })
  .default({});
const telegramSendToolConfigSchema = z
  .object({
    allowedChatIds: z.array(z.string()).default([]),
  })
  .default({});
const githubToolConfigSchema = z
  .object({
    defaultRepository: z.string().optional(),
    command: z.string().min(1).default("gh"),
    commandTimeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    maxItems: z.number().int().min(1).max(50).default(10),
    maxOutputBytes: z.number().int().min(1).max(500_000).default(80_000),
  })
  .default({});
const microsoftTodoToolConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    tenantId: z.string().optional(),
    clientId: z.string().optional(),
    graphBaseUrl: z.string().min(1).default("https://graph.microsoft.com/v1.0"),
    accessTokenEnv: z.string().min(1).default("MOTTBOT_MICROSOFT_TODO_ACCESS_TOKEN"),
    defaultListId: z.string().optional(),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    maxItems: z.number().int().min(1).max(200).default(25),
  })
  .default({});
const googleDriveToolConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    driveBaseUrl: z.string().min(1).default("https://www.googleapis.com/drive/v3"),
    docsBaseUrl: z.string().min(1).default("https://docs.googleapis.com/v1"),
    accessTokenEnv: z.string().min(1).default("MOTTBOT_GOOGLE_DRIVE_ACCESS_TOKEN"),
    timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
    maxItems: z.number().int().min(1).max(200).default(25),
    maxBytes: z.number().int().min(1).max(500_000).default(120_000),
  })
  .default({});
const mcpServerConfigSchema = z.object({
  name: z.string().min(1).max(64),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).default([]),
  allowedTools: z.array(z.string().min(1).max(128)).default([]),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  maxOutputBytes: z.number().int().min(1).max(200_000).default(40_000),
});
const mcpToolConfigSchema = z
  .object({
    servers: z.array(mcpServerConfigSchema).default([]),
  })
  .default({});
const projectTasksConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    repoRoots: z.array(z.string()).default(["."]),
    worktreeRoot: z.string().default("./data/project-worktrees"),
    artifactRoot: z.string().default("./data/project-runs"),
    maxConcurrentProjects: z.number().int().min(1).max(10).default(1),
    defaultMaxParallelWorkersPerProject: z.number().int().min(1).max(8).default(1),
    hardMaxParallelWorkersPerProject: z.number().int().min(1).max(8).default(2),
    maxConcurrentCodexWorkersGlobal: z.number().int().min(1).max(16).default(2),
    defaultBaseRef: z.string().min(1).default("main"),
    codex: z
      .object({
        command: z.string().min(1).default("codex"),
        coderProfile: z.string().min(1).default("mottbot-coder"),
        reviewerProfile: z.string().min(1).default("mottbot-reviewer"),
        defaultTimeoutMs: z
          .number()
          .int()
          .min(30_000)
          .max(24 * 60 * 60 * 1000)
          .default(60 * 60 * 1000),
      })
      .default({}),
    approvals: z
      .object({
        requireBeforeProjectStart: z.boolean().default(true),
      })
      .default({}),
  })
  .default({});

const rawConfigSchema = z.object({
  telegram: z
    .object({
      botToken: z.string().min(1).optional(),
      polling: z.boolean().default(true),
      adminUserIds: z.array(z.string()).default([]),
      allowedChatIds: z.array(z.string()).default([]),
      webhook: z
        .object({
          publicUrl: z.string().optional(),
          path: z.string().default("/telegram/webhook"),
          host: z.string().default("0.0.0.0"),
          port: z.number().int().default(8080),
          secretToken: z.string().optional(),
        })
        .default({}),
      reactions: z
        .object({
          enabled: z.boolean().default(true),
          ackEmoji: z.string().max(32).default("\u{1F440}"),
          removeAckAfterReply: z.boolean().default(false),
          notifications: telegramReactionNotificationsSchema.default("own"),
        })
        .default({}),
    })
    .default({}),
  models: z
    .object({
      default: z.string().default("openai-codex/gpt-5.4"),
      transport: transportSchema.default("auto"),
    })
    .default({}),
  auth: z
    .object({
      defaultProfile: z.string().default("openai-codex:default"),
      preferCliImport: z.boolean().default(true),
    })
    .default({}),
  agents: agentsConfigSchema,
  storage: z
    .object({
      sqlitePath: z.string().default("./data/mottbot.sqlite"),
    })
    .default({}),
  attachments: z
    .object({
      cacheDir: z.string().default("./data/attachments"),
      maxFileBytes: z
        .number()
        .int()
        .min(1)
        .default(20 * 1024 * 1024),
      maxTotalBytes: z
        .number()
        .int()
        .min(1)
        .default(30 * 1024 * 1024),
      maxPerMessage: z.number().int().min(0).max(10).default(4),
      maxExtractedTextCharsPerFile: z.number().int().min(0).default(40_000),
      maxExtractedTextCharsTotal: z.number().int().min(0).default(80_000),
      csvPreviewRows: z.number().int().min(1).max(200).default(40),
      csvPreviewColumns: z.number().int().min(1).max(100).default(20),
      pdfMaxPages: z.number().int().min(1).max(200).default(25),
    })
    .default({}),
  behavior: z
    .object({
      respondInGroupsOnlyWhenMentioned: z.boolean().default(true),
      editThrottleMs: z.number().int().min(250).default(750),
      maxInboundTextChars: z.number().int().min(1).default(12_000),
    })
    .default({}),
  logging: z
    .object({
      level: z.string().default("info"),
    })
    .default({}),
  oauth: z
    .object({
      callbackHost: z.string().default("127.0.0.1"),
      callbackPort: z.number().int().default(1455),
    })
    .default({}),
  dashboard: z
    .object({
      enabled: z.boolean().default(true),
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(8787),
      path: z.string().default("/dashboard"),
      apiPath: z.string().default("/api/dashboard"),
      authToken: z.string().optional(),
    })
    .default({}),
  tools: z
    .object({
      enableSideEffectTools: z.boolean().default(false),
      approvalTtlMs: z
        .number()
        .int()
        .min(1_000)
        .default(5 * 60 * 1000),
      restartDelayMs: z.number().int().min(1_000).default(60_000),
      policies: z.record(toolPolicyConfigSchema).default({}),
      repository: repositoryToolConfigSchema,
      localWrite: localWriteToolConfigSchema,
      localExec: localExecToolConfigSchema,
      telegramSend: telegramSendToolConfigSchema,
      github: githubToolConfigSchema,
      microsoftTodo: microsoftTodoToolConfigSchema,
      googleDrive: googleDriveToolConfigSchema,
      mcp: mcpToolConfigSchema,
    })
    .default({}),
  runtime: z
    .object({
      instanceLeaseEnabled: z.boolean().default(true),
      instanceLeaseTtlMs: z
        .number()
        .int()
        .min(5_000)
        .default(2 * 60 * 1000),
      instanceLeaseRefreshMs: z.number().int().min(1_000).default(30_000),
    })
    .default({}),
  memory: z
    .object({
      autoSummariesEnabled: z.boolean().default(false),
      autoSummaryRecentMessages: z.number().int().min(4).max(40).default(12),
      autoSummaryMaxChars: z.number().int().min(200).max(4_000).default(1_000),
      candidateExtractionEnabled: z.boolean().default(false),
      candidateRecentMessages: z.number().int().min(4).max(40).default(12),
      candidateMaxPerRun: z.number().int().min(1).max(10).default(5),
    })
    .default({}),
  usage: usageBudgetConfigSchema,
  security: z
    .object({
      masterKey: z.string().min(1).optional(),
    })
    .default({}),
  projectTasks: projectTasksConfigSchema,
});

/** Fully validated runtime configuration with defaults and filesystem paths resolved. */
export type AppConfig = {
  configPath: string;
  telegram: {
    botToken: string;
    polling: boolean;
    adminUserIds: string[];
    allowedChatIds: string[];
    webhook: {
      publicUrl?: string;
      path: string;
      host: string;
      port: number;
      secretToken?: string;
    };
    reactions: {
      enabled: boolean;
      ackEmoji: string;
      removeAckAfterReply: boolean;
      notifications: z.infer<typeof telegramReactionNotificationsSchema>;
    };
  };
  models: {
    default: string;
    transport: z.infer<typeof transportSchema>;
  };
  auth: {
    defaultProfile: string;
    preferCliImport: boolean;
  };
  agents: {
    defaultId: string;
    list: AgentConfig[];
    bindings: AgentRoutingBinding[];
  };
  storage: {
    sqlitePath: string;
  };
  attachments: {
    cacheDir: string;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxPerMessage: number;
    maxExtractedTextCharsPerFile: number;
    maxExtractedTextCharsTotal: number;
    csvPreviewRows: number;
    csvPreviewColumns: number;
    pdfMaxPages: number;
  };
  behavior: {
    respondInGroupsOnlyWhenMentioned: boolean;
    editThrottleMs: number;
    maxInboundTextChars: number;
  };
  logging: {
    level: string;
  };
  oauth: {
    callbackHost: string;
    callbackPort: number;
  };
  dashboard: {
    enabled: boolean;
    host: string;
    port: number;
    path: string;
    apiPath: string;
    authToken?: string;
  };
  tools: {
    enableSideEffectTools: boolean;
    approvalTtlMs: number;
    restartDelayMs: number;
    policies: Record<string, z.infer<typeof toolPolicyConfigSchema>>;
    repository: z.infer<typeof repositoryToolConfigSchema>;
    localWrite: z.infer<typeof localWriteToolConfigSchema>;
    localExec: z.infer<typeof localExecToolConfigSchema>;
    telegramSend: z.infer<typeof telegramSendToolConfigSchema>;
    github: z.infer<typeof githubToolConfigSchema>;
    microsoftTodo: z.infer<typeof microsoftTodoToolConfigSchema>;
    googleDrive: z.infer<typeof googleDriveToolConfigSchema>;
    mcp: z.infer<typeof mcpToolConfigSchema>;
  };
  runtime: {
    instanceLeaseEnabled: boolean;
    instanceLeaseTtlMs: number;
    instanceLeaseRefreshMs: number;
  };
  memory: {
    autoSummariesEnabled: boolean;
    autoSummaryRecentMessages: number;
    autoSummaryMaxChars: number;
    candidateExtractionEnabled: boolean;
    candidateRecentMessages: number;
    candidateMaxPerRun: number;
  };
  usage: z.infer<typeof usageBudgetConfigSchema>;
  security: {
    masterKey: string;
  };
  projectTasks: z.infer<typeof projectTasksConfigSchema> & {
    repoRoots: string[];
    worktreeRoot: string;
    artifactRoot: string;
  };
};

/** Per-agent routing and model defaults after config normalization. */
export type AgentConfig = {
  id: string;
  displayName?: string;
  profileId: string;
  modelRef: string;
  systemPrompt?: string;
  fastMode: boolean;
  toolNames?: string[];
  toolPolicies?: Record<string, z.infer<typeof toolPolicyConfigSchema>>;
  maxConcurrentRuns?: number;
  maxQueuedRuns?: number;
};

/** Telegram routing selector that binds a chat, thread, user, or chat type to an agent. */
export type AgentRoutingBinding = z.infer<typeof agentRoutingBindingSchema>;

function readConfigFile(configPath: string): unknown {
  if (!fileExists(configPath)) {
    return {};
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

function normalizeAgents(
  rawAgents: z.infer<typeof agentsConfigSchema>,
  defaults: { profileId: string; modelRef: string },
): AppConfig["agents"] {
  const agents = new Map<string, AgentConfig>();
  for (const rawAgent of rawAgents.list) {
    if (agents.has(rawAgent.id)) {
      throw new Error(`Duplicate agent id '${rawAgent.id}'.`);
    }
    agents.set(rawAgent.id, {
      id: rawAgent.id,
      ...(rawAgent.displayName ? { displayName: rawAgent.displayName } : {}),
      profileId: rawAgent.profileId ?? defaults.profileId,
      modelRef: rawAgent.modelRef ?? defaults.modelRef,
      ...(rawAgent.systemPrompt ? { systemPrompt: rawAgent.systemPrompt } : {}),
      fastMode: rawAgent.fastMode ?? false,
      ...(rawAgent.toolNames ? { toolNames: rawAgent.toolNames } : {}),
      ...(rawAgent.toolPolicies ? { toolPolicies: rawAgent.toolPolicies } : {}),
      ...(rawAgent.maxConcurrentRuns !== undefined ? { maxConcurrentRuns: rawAgent.maxConcurrentRuns } : {}),
      ...(rawAgent.maxQueuedRuns !== undefined ? { maxQueuedRuns: rawAgent.maxQueuedRuns } : {}),
    });
  }
  if (!agents.has(rawAgents.defaultId)) {
    agents.set(rawAgents.defaultId, {
      id: rawAgents.defaultId,
      profileId: defaults.profileId,
      modelRef: defaults.modelRef,
      fastMode: false,
    });
  }
  for (const binding of rawAgents.bindings) {
    if (!agents.has(binding.agentId)) {
      throw new Error(`Agent binding references unknown agent '${binding.agentId}'.`);
    }
  }
  return {
    defaultId: rawAgents.defaultId,
    list: [...agents.values()],
    bindings: rawAgents.bindings,
  };
}

/** Resolves the config file path from MOTTBOT_CONFIG_PATH or the default project file. */
export function resolveConfigPath(): string {
  const fromEnv = process.env.MOTTBOT_CONFIG_PATH?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve("mottbot.config.json");
}

/** Loads, validates, and normalizes the operator config file for application startup. */
export function loadConfig(): AppConfig {
  const configPath = resolveConfigPath();
  const fileConfig = readConfigFile(configPath);
  const fileObject = typeof fileConfig === "object" && fileConfig ? (fileConfig as Record<string, unknown>) : {};
  const parsed = rawConfigSchema.parse(fileObject);

  const botToken = parsed.telegram.botToken?.trim();
  if (!botToken) {
    throw new Error(`Missing telegram.botToken in ${configPath}.`);
  }

  const masterKey = parsed.security.masterKey?.trim();
  if (!masterKey) {
    throw new Error(`Missing security.masterKey in ${configPath}.`);
  }
  const agents = normalizeAgents(parsed.agents, {
    profileId: parsed.auth.defaultProfile,
    modelRef: parsed.models.default,
  });

  return {
    configPath,
    telegram: {
      botToken,
      polling: parsed.telegram.polling,
      adminUserIds: parsed.telegram.adminUserIds,
      allowedChatIds: parsed.telegram.allowedChatIds,
      webhook: parsed.telegram.webhook,
      reactions: parsed.telegram.reactions,
    },
    models: parsed.models,
    auth: parsed.auth,
    agents,
    storage: {
      sqlitePath: path.resolve(parsed.storage.sqlitePath),
    },
    attachments: {
      cacheDir: path.resolve(parsed.attachments.cacheDir),
      maxFileBytes: parsed.attachments.maxFileBytes,
      maxTotalBytes: parsed.attachments.maxTotalBytes,
      maxPerMessage: parsed.attachments.maxPerMessage,
      maxExtractedTextCharsPerFile: parsed.attachments.maxExtractedTextCharsPerFile,
      maxExtractedTextCharsTotal: parsed.attachments.maxExtractedTextCharsTotal,
      csvPreviewRows: parsed.attachments.csvPreviewRows,
      csvPreviewColumns: parsed.attachments.csvPreviewColumns,
      pdfMaxPages: parsed.attachments.pdfMaxPages,
    },
    behavior: parsed.behavior,
    logging: parsed.logging,
    oauth: parsed.oauth,
    dashboard: parsed.dashboard,
    tools: parsed.tools,
    runtime: parsed.runtime,
    memory: parsed.memory,
    usage: parsed.usage,
    security: {
      masterKey,
    },
    projectTasks: {
      ...parsed.projectTasks,
      repoRoots: parsed.projectTasks.repoRoots.map((entry) => path.resolve(entry)),
      worktreeRoot: path.resolve(parsed.projectTasks.worktreeRoot),
      artifactRoot: path.resolve(parsed.projectTasks.artifactRoot),
    },
  };
}
