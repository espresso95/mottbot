import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { fileExists } from "../shared/fs.js";

dotenv.config();

const transportSchema = z.enum(["auto", "sse", "websocket"]);
const telegramReactionNotificationsSchema = z.enum(["off", "own", "all"]);
const toolCallerRoleSchema = z.enum(["admin", "user"]);
const toolPolicyConfigSchema = z.object({
  allowedRoles: z.array(toolCallerRoleSchema).optional(),
  allowedChatIds: z.array(z.string()).optional(),
  requiresApproval: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  maxOutputBytes: z.number().int().min(1).optional(),
});
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

const rawConfigSchema = z.object({
  telegram: z
    .object({
      botTokenEnv: z.string().default("TELEGRAM_BOT_TOKEN"),
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
  storage: z
    .object({
      sqlitePath: z.string().default("./data/mottbot.sqlite"),
    })
    .default({}),
  attachments: z
    .object({
      cacheDir: z.string().default("./data/attachments"),
      maxFileBytes: z.number().int().min(1).default(20 * 1024 * 1024),
      maxTotalBytes: z.number().int().min(1).default(30 * 1024 * 1024),
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
      approvalTtlMs: z.number().int().min(1_000).default(5 * 60 * 1000),
      restartDelayMs: z.number().int().min(1_000).default(60_000),
      policies: z.record(toolPolicyConfigSchema).default({}),
      repository: repositoryToolConfigSchema,
      localWrite: localWriteToolConfigSchema,
      telegramSend: telegramSendToolConfigSchema,
      github: githubToolConfigSchema,
    })
    .default({}),
  runtime: z
    .object({
      instanceLeaseEnabled: z.boolean().default(true),
      instanceLeaseTtlMs: z.number().int().min(5_000).default(2 * 60 * 1000),
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
});

export type AppConfig = {
  configPath: string;
  telegram: {
    botToken: string;
    botTokenEnv: string;
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
    telegramSend: z.infer<typeof telegramSendToolConfigSchema>;
    github: z.infer<typeof githubToolConfigSchema>;
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
  security: {
    masterKey: string;
  };
};

function parseCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function pickDefined<T>(...values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readConfigFile(configPath: string): unknown {
  if (!fileExists(configPath)) {
    return {};
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw);
}

function parseJsonEnv(name: string): unknown | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw);
}

export function resolveConfigPath(): string {
  const fromEnv = process.env.MOTTBOT_CONFIG_PATH?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.resolve("mottbot.config.json");
}

export function loadConfig(): AppConfig {
  const configPath = resolveConfigPath();
  const fileConfig = readConfigFile(configPath);
  const fileObject =
    typeof fileConfig === "object" && fileConfig ? (fileConfig as Record<string, unknown>) : {};
  const fileTools = asRecord(fileObject.tools);
  const fileRepositoryTools = asRecord(fileTools?.repository);
  const fileLocalWriteTools = asRecord(fileTools?.localWrite);
  const fileTelegramSendTools = asRecord(fileTools?.telegramSend);
  const fileGithubTools = asRecord(fileTools?.github);
  const parsed = rawConfigSchema.parse({
    ...fileObject,
    telegram: {
      ...(fileObject.telegram && typeof fileObject.telegram === "object" ? (fileObject.telegram as object) : {}),
      adminUserIds: pickDefined(
        process.env.MOTTBOT_ADMIN_USER_IDS !== undefined
          ? parseCsv(process.env.MOTTBOT_ADMIN_USER_IDS)
          : undefined,
        fileObject.telegram && typeof fileObject.telegram === "object"
          ? (fileObject.telegram as any).adminUserIds
          : undefined,
      ),
      allowedChatIds: pickDefined(
        process.env.MOTTBOT_ALLOWED_CHAT_IDS !== undefined
          ? parseCsv(process.env.MOTTBOT_ALLOWED_CHAT_IDS)
          : undefined,
        fileObject.telegram && typeof fileObject.telegram === "object"
          ? (fileObject.telegram as any).allowedChatIds
          : undefined,
      ),
      polling:
        process.env.MOTTBOT_TELEGRAM_POLLING === undefined
          ? (fileObject.telegram && typeof fileObject.telegram === "object"
              ? (fileObject.telegram as any).polling
              : true)
          : process.env.MOTTBOT_TELEGRAM_POLLING !== "false",
      webhook: {
        ...(
          fileObject.telegram &&
          typeof fileObject.telegram === "object" &&
          (fileObject.telegram as any).webhook &&
          typeof (fileObject.telegram as any).webhook === "object"
            ? ((fileObject.telegram as any).webhook as object)
            : {}
        ),
        publicUrl:
          process.env.MOTTBOT_TELEGRAM_WEBHOOK_URL ??
          (fileObject.telegram &&
          typeof fileObject.telegram === "object" &&
          (fileObject.telegram as any).webhook &&
          typeof (fileObject.telegram as any).webhook === "object"
            ? (fileObject.telegram as any).webhook.publicUrl
            : undefined),
        path:
          process.env.MOTTBOT_TELEGRAM_WEBHOOK_PATH ??
          (fileObject.telegram &&
          typeof fileObject.telegram === "object" &&
          (fileObject.telegram as any).webhook &&
          typeof (fileObject.telegram as any).webhook === "object"
            ? (fileObject.telegram as any).webhook.path
            : undefined),
        host:
          process.env.MOTTBOT_TELEGRAM_WEBHOOK_HOST ??
          (fileObject.telegram &&
          typeof fileObject.telegram === "object" &&
          (fileObject.telegram as any).webhook &&
          typeof (fileObject.telegram as any).webhook === "object"
            ? (fileObject.telegram as any).webhook.host
            : undefined),
        port:
          process.env.MOTTBOT_TELEGRAM_WEBHOOK_PORT === undefined
            ? (fileObject.telegram &&
              typeof fileObject.telegram === "object" &&
              (fileObject.telegram as any).webhook &&
              typeof (fileObject.telegram as any).webhook === "object"
                ? (fileObject.telegram as any).webhook.port
                : undefined)
            : Number(process.env.MOTTBOT_TELEGRAM_WEBHOOK_PORT),
        secretToken:
          process.env.MOTTBOT_TELEGRAM_WEBHOOK_SECRET_TOKEN ??
          (fileObject.telegram &&
          typeof fileObject.telegram === "object" &&
          (fileObject.telegram as any).webhook &&
          typeof (fileObject.telegram as any).webhook === "object"
            ? (fileObject.telegram as any).webhook.secretToken
            : undefined),
      },
      reactions: {
        ...(
          fileObject.telegram &&
          typeof fileObject.telegram === "object" &&
          (fileObject.telegram as any).reactions &&
          typeof (fileObject.telegram as any).reactions === "object"
            ? ((fileObject.telegram as any).reactions as object)
            : {}
        ),
        enabled:
          process.env.MOTTBOT_TELEGRAM_REACTIONS_ENABLED === undefined
            ? (fileObject.telegram &&
              typeof fileObject.telegram === "object" &&
              (fileObject.telegram as any).reactions &&
              typeof (fileObject.telegram as any).reactions === "object"
                ? (fileObject.telegram as any).reactions.enabled
                : undefined)
            : process.env.MOTTBOT_TELEGRAM_REACTIONS_ENABLED !== "false",
        ackEmoji:
          process.env.MOTTBOT_TELEGRAM_ACK_REACTION ??
          (fileObject.telegram &&
          typeof fileObject.telegram === "object" &&
          (fileObject.telegram as any).reactions &&
          typeof (fileObject.telegram as any).reactions === "object"
            ? (fileObject.telegram as any).reactions.ackEmoji
            : undefined),
        removeAckAfterReply:
          process.env.MOTTBOT_TELEGRAM_REMOVE_ACK_AFTER_REPLY === undefined
            ? (fileObject.telegram &&
              typeof fileObject.telegram === "object" &&
              (fileObject.telegram as any).reactions &&
              typeof (fileObject.telegram as any).reactions === "object"
                ? (fileObject.telegram as any).reactions.removeAckAfterReply
                : undefined)
            : process.env.MOTTBOT_TELEGRAM_REMOVE_ACK_AFTER_REPLY === "true",
        notifications:
          process.env.MOTTBOT_TELEGRAM_REACTION_NOTIFICATIONS ??
          (fileObject.telegram &&
          typeof fileObject.telegram === "object" &&
          (fileObject.telegram as any).reactions &&
          typeof (fileObject.telegram as any).reactions === "object"
            ? (fileObject.telegram as any).reactions.notifications
            : undefined),
      },
    },
    models: {
      ...(fileObject.models && typeof fileObject.models === "object" ? (fileObject.models as object) : {}),
      default:
        process.env.MOTTBOT_DEFAULT_MODEL ??
        (fileObject.models && typeof fileObject.models === "object"
          ? (fileObject.models as any).default
          : undefined),
      transport:
        process.env.MOTTBOT_TRANSPORT ??
        (fileObject.models && typeof fileObject.models === "object"
          ? (fileObject.models as any).transport
          : undefined),
    },
    auth: {
      ...(fileObject.auth && typeof fileObject.auth === "object" ? (fileObject.auth as object) : {}),
      defaultProfile:
        process.env.MOTTBOT_DEFAULT_PROFILE ??
        (fileObject.auth && typeof fileObject.auth === "object"
          ? (fileObject.auth as any).defaultProfile
          : undefined),
      preferCliImport:
        process.env.MOTTBOT_PREFER_CLI_IMPORT === undefined
          ? (fileObject.auth && typeof fileObject.auth === "object"
              ? (fileObject.auth as any).preferCliImport
              : undefined)
          : process.env.MOTTBOT_PREFER_CLI_IMPORT !== "false",
    },
    storage: {
      ...(fileObject.storage && typeof fileObject.storage === "object" ? (fileObject.storage as object) : {}),
      sqlitePath:
        process.env.MOTTBOT_SQLITE_PATH ??
        (fileObject.storage && typeof fileObject.storage === "object"
          ? (fileObject.storage as any).sqlitePath
          : undefined),
    },
    attachments: {
      ...(fileObject.attachments && typeof fileObject.attachments === "object"
        ? (fileObject.attachments as object)
        : {}),
      cacheDir:
        process.env.MOTTBOT_ATTACHMENT_CACHE_DIR ??
        (fileObject.attachments && typeof fileObject.attachments === "object"
          ? (fileObject.attachments as any).cacheDir
          : undefined),
      maxFileBytes:
        process.env.MOTTBOT_ATTACHMENT_MAX_FILE_BYTES === undefined
          ? (fileObject.attachments && typeof fileObject.attachments === "object"
              ? (fileObject.attachments as any).maxFileBytes
              : undefined)
          : Number(process.env.MOTTBOT_ATTACHMENT_MAX_FILE_BYTES),
      maxTotalBytes:
        process.env.MOTTBOT_ATTACHMENT_MAX_TOTAL_BYTES === undefined
          ? (fileObject.attachments && typeof fileObject.attachments === "object"
              ? (fileObject.attachments as any).maxTotalBytes
              : undefined)
          : Number(process.env.MOTTBOT_ATTACHMENT_MAX_TOTAL_BYTES),
      maxPerMessage:
        process.env.MOTTBOT_ATTACHMENT_MAX_PER_MESSAGE === undefined
          ? (fileObject.attachments && typeof fileObject.attachments === "object"
              ? (fileObject.attachments as any).maxPerMessage
              : undefined)
          : Number(process.env.MOTTBOT_ATTACHMENT_MAX_PER_MESSAGE),
      maxExtractedTextCharsPerFile:
        process.env.MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_PER_FILE === undefined
          ? (fileObject.attachments && typeof fileObject.attachments === "object"
              ? (fileObject.attachments as any).maxExtractedTextCharsPerFile
              : undefined)
          : Number(process.env.MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_PER_FILE),
      maxExtractedTextCharsTotal:
        process.env.MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_TOTAL === undefined
          ? (fileObject.attachments && typeof fileObject.attachments === "object"
              ? (fileObject.attachments as any).maxExtractedTextCharsTotal
              : undefined)
          : Number(process.env.MOTTBOT_ATTACHMENT_MAX_EXTRACTED_TEXT_CHARS_TOTAL),
      csvPreviewRows:
        process.env.MOTTBOT_ATTACHMENT_CSV_PREVIEW_ROWS === undefined
          ? (fileObject.attachments && typeof fileObject.attachments === "object"
              ? (fileObject.attachments as any).csvPreviewRows
              : undefined)
          : Number(process.env.MOTTBOT_ATTACHMENT_CSV_PREVIEW_ROWS),
      csvPreviewColumns:
        process.env.MOTTBOT_ATTACHMENT_CSV_PREVIEW_COLUMNS === undefined
          ? (fileObject.attachments && typeof fileObject.attachments === "object"
              ? (fileObject.attachments as any).csvPreviewColumns
              : undefined)
          : Number(process.env.MOTTBOT_ATTACHMENT_CSV_PREVIEW_COLUMNS),
      pdfMaxPages:
        process.env.MOTTBOT_ATTACHMENT_PDF_MAX_PAGES === undefined
          ? (fileObject.attachments && typeof fileObject.attachments === "object"
              ? (fileObject.attachments as any).pdfMaxPages
              : undefined)
          : Number(process.env.MOTTBOT_ATTACHMENT_PDF_MAX_PAGES),
    },
    behavior: {
      ...(fileObject.behavior && typeof fileObject.behavior === "object"
        ? (fileObject.behavior as object)
        : {}),
      respondInGroupsOnlyWhenMentioned:
        process.env.MOTTBOT_GROUP_MENTION_ONLY === undefined
          ? (fileObject.behavior && typeof fileObject.behavior === "object"
              ? (fileObject.behavior as any).respondInGroupsOnlyWhenMentioned
              : undefined)
          : process.env.MOTTBOT_GROUP_MENTION_ONLY !== "false",
      editThrottleMs:
        process.env.MOTTBOT_EDIT_THROTTLE_MS === undefined
          ? (fileObject.behavior && typeof fileObject.behavior === "object"
              ? (fileObject.behavior as any).editThrottleMs
              : undefined)
          : Number(process.env.MOTTBOT_EDIT_THROTTLE_MS),
      maxInboundTextChars:
        process.env.MOTTBOT_MAX_INBOUND_TEXT_CHARS === undefined
          ? (fileObject.behavior && typeof fileObject.behavior === "object"
              ? (fileObject.behavior as any).maxInboundTextChars
              : undefined)
          : Number(process.env.MOTTBOT_MAX_INBOUND_TEXT_CHARS),
    },
    logging: {
      ...(fileObject.logging && typeof fileObject.logging === "object" ? (fileObject.logging as object) : {}),
      level:
        process.env.MOTTBOT_LOG_LEVEL ??
        (fileObject.logging && typeof fileObject.logging === "object"
          ? (fileObject.logging as any).level
          : undefined),
    },
    oauth: {
      ...(fileObject.oauth && typeof fileObject.oauth === "object" ? (fileObject.oauth as object) : {}),
      callbackHost:
        process.env.MOTTBOT_OAUTH_CALLBACK_HOST ??
        (fileObject.oauth && typeof fileObject.oauth === "object"
          ? (fileObject.oauth as any).callbackHost
          : undefined),
      callbackPort:
        process.env.MOTTBOT_OAUTH_CALLBACK_PORT === undefined
          ? (fileObject.oauth && typeof fileObject.oauth === "object"
              ? (fileObject.oauth as any).callbackPort
              : undefined)
          : Number(process.env.MOTTBOT_OAUTH_CALLBACK_PORT),
    },
    dashboard: {
      ...(fileObject.dashboard && typeof fileObject.dashboard === "object"
        ? (fileObject.dashboard as object)
        : {}),
      enabled:
        process.env.MOTTBOT_DASHBOARD_ENABLED === undefined
          ? (fileObject.dashboard && typeof fileObject.dashboard === "object"
              ? (fileObject.dashboard as any).enabled
              : undefined)
          : process.env.MOTTBOT_DASHBOARD_ENABLED !== "false",
      host:
        process.env.MOTTBOT_DASHBOARD_HOST ??
        (fileObject.dashboard && typeof fileObject.dashboard === "object"
          ? (fileObject.dashboard as any).host
          : undefined),
      port:
        process.env.MOTTBOT_DASHBOARD_PORT === undefined
          ? (fileObject.dashboard && typeof fileObject.dashboard === "object"
              ? (fileObject.dashboard as any).port
              : undefined)
          : Number(process.env.MOTTBOT_DASHBOARD_PORT),
      path:
        process.env.MOTTBOT_DASHBOARD_PATH ??
        (fileObject.dashboard && typeof fileObject.dashboard === "object"
          ? (fileObject.dashboard as any).path
          : undefined),
      apiPath:
        process.env.MOTTBOT_DASHBOARD_API_PATH ??
        (fileObject.dashboard && typeof fileObject.dashboard === "object"
          ? (fileObject.dashboard as any).apiPath
          : undefined),
      authToken:
        process.env.MOTTBOT_DASHBOARD_AUTH_TOKEN ??
        (fileObject.dashboard && typeof fileObject.dashboard === "object"
          ? (fileObject.dashboard as any).authToken
          : undefined),
    },
    tools: {
      ...(fileObject.tools && typeof fileObject.tools === "object" ? (fileObject.tools as object) : {}),
      enableSideEffectTools:
        process.env.MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS === undefined
          ? (fileObject.tools && typeof fileObject.tools === "object"
              ? (fileObject.tools as any).enableSideEffectTools
              : undefined)
          : process.env.MOTTBOT_ENABLE_SIDE_EFFECT_TOOLS === "true",
      approvalTtlMs:
        process.env.MOTTBOT_TOOL_APPROVAL_TTL_MS === undefined
          ? (fileObject.tools && typeof fileObject.tools === "object"
              ? (fileObject.tools as any).approvalTtlMs
              : undefined)
          : Number(process.env.MOTTBOT_TOOL_APPROVAL_TTL_MS),
      restartDelayMs:
        process.env.MOTTBOT_RESTART_TOOL_DELAY_MS === undefined
          ? (fileObject.tools && typeof fileObject.tools === "object"
              ? (fileObject.tools as any).restartDelayMs
              : undefined)
          : Number(process.env.MOTTBOT_RESTART_TOOL_DELAY_MS),
      policies:
        parseJsonEnv("MOTTBOT_TOOL_POLICIES_JSON") ??
        (fileObject.tools && typeof fileObject.tools === "object"
          ? (fileObject.tools as any).policies
          : undefined),
      repository: {
        ...(fileRepositoryTools ?? {}),
        roots: pickDefined(
          process.env.MOTTBOT_REPOSITORY_ROOTS !== undefined
            ? parseCsv(process.env.MOTTBOT_REPOSITORY_ROOTS)
            : undefined,
          fileRepositoryTools?.roots,
        ),
        deniedPaths: pickDefined(
          process.env.MOTTBOT_REPOSITORY_DENIED_PATHS !== undefined
            ? parseCsv(process.env.MOTTBOT_REPOSITORY_DENIED_PATHS)
            : undefined,
          fileRepositoryTools?.deniedPaths,
        ),
        maxReadBytes:
          process.env.MOTTBOT_REPOSITORY_MAX_READ_BYTES === undefined
            ? fileRepositoryTools?.maxReadBytes
            : Number(process.env.MOTTBOT_REPOSITORY_MAX_READ_BYTES),
        maxSearchMatches:
          process.env.MOTTBOT_REPOSITORY_MAX_SEARCH_MATCHES === undefined
            ? fileRepositoryTools?.maxSearchMatches
            : Number(process.env.MOTTBOT_REPOSITORY_MAX_SEARCH_MATCHES),
        maxSearchBytes:
          process.env.MOTTBOT_REPOSITORY_MAX_SEARCH_BYTES === undefined
            ? fileRepositoryTools?.maxSearchBytes
            : Number(process.env.MOTTBOT_REPOSITORY_MAX_SEARCH_BYTES),
        commandTimeoutMs:
          process.env.MOTTBOT_REPOSITORY_COMMAND_TIMEOUT_MS === undefined
            ? fileRepositoryTools?.commandTimeoutMs
            : Number(process.env.MOTTBOT_REPOSITORY_COMMAND_TIMEOUT_MS),
      },
      localWrite: {
        ...(fileLocalWriteTools ?? {}),
        roots: pickDefined(
          process.env.MOTTBOT_LOCAL_WRITE_ROOTS !== undefined
            ? parseCsv(process.env.MOTTBOT_LOCAL_WRITE_ROOTS)
            : undefined,
          fileLocalWriteTools?.roots,
        ),
        deniedPaths: pickDefined(
          process.env.MOTTBOT_LOCAL_WRITE_DENIED_PATHS !== undefined
            ? parseCsv(process.env.MOTTBOT_LOCAL_WRITE_DENIED_PATHS)
            : undefined,
          fileLocalWriteTools?.deniedPaths,
        ),
        maxWriteBytes:
          process.env.MOTTBOT_LOCAL_WRITE_MAX_BYTES === undefined
            ? fileLocalWriteTools?.maxWriteBytes
            : Number(process.env.MOTTBOT_LOCAL_WRITE_MAX_BYTES),
      },
      telegramSend: {
        ...(fileTelegramSendTools ?? {}),
        allowedChatIds: pickDefined(
          process.env.MOTTBOT_TELEGRAM_SEND_ALLOWED_CHAT_IDS !== undefined
            ? parseCsv(process.env.MOTTBOT_TELEGRAM_SEND_ALLOWED_CHAT_IDS)
            : undefined,
          fileTelegramSendTools?.allowedChatIds,
        ),
      },
      github: {
        ...(fileGithubTools ?? {}),
        defaultRepository:
          process.env.MOTTBOT_GITHUB_REPOSITORY !== undefined
            ? process.env.MOTTBOT_GITHUB_REPOSITORY.trim() || undefined
            : fileGithubTools?.defaultRepository,
        command:
          process.env.MOTTBOT_GITHUB_COMMAND !== undefined
            ? process.env.MOTTBOT_GITHUB_COMMAND.trim() || undefined
            : fileGithubTools?.command,
        commandTimeoutMs:
          process.env.MOTTBOT_GITHUB_COMMAND_TIMEOUT_MS === undefined
            ? fileGithubTools?.commandTimeoutMs
            : Number(process.env.MOTTBOT_GITHUB_COMMAND_TIMEOUT_MS),
        maxItems:
          process.env.MOTTBOT_GITHUB_MAX_ITEMS === undefined
            ? fileGithubTools?.maxItems
            : Number(process.env.MOTTBOT_GITHUB_MAX_ITEMS),
        maxOutputBytes:
          process.env.MOTTBOT_GITHUB_MAX_OUTPUT_BYTES === undefined
            ? fileGithubTools?.maxOutputBytes
            : Number(process.env.MOTTBOT_GITHUB_MAX_OUTPUT_BYTES),
      },
    },
    runtime: {
      ...(fileObject.runtime && typeof fileObject.runtime === "object" ? (fileObject.runtime as object) : {}),
      instanceLeaseEnabled:
        process.env.MOTTBOT_INSTANCE_LEASE_ENABLED === undefined
          ? (fileObject.runtime && typeof fileObject.runtime === "object"
              ? (fileObject.runtime as any).instanceLeaseEnabled
              : undefined)
          : process.env.MOTTBOT_INSTANCE_LEASE_ENABLED !== "false",
      instanceLeaseTtlMs:
        process.env.MOTTBOT_INSTANCE_LEASE_TTL_MS === undefined
          ? (fileObject.runtime && typeof fileObject.runtime === "object"
              ? (fileObject.runtime as any).instanceLeaseTtlMs
              : undefined)
          : Number(process.env.MOTTBOT_INSTANCE_LEASE_TTL_MS),
      instanceLeaseRefreshMs:
        process.env.MOTTBOT_INSTANCE_LEASE_REFRESH_MS === undefined
          ? (fileObject.runtime && typeof fileObject.runtime === "object"
              ? (fileObject.runtime as any).instanceLeaseRefreshMs
              : undefined)
          : Number(process.env.MOTTBOT_INSTANCE_LEASE_REFRESH_MS),
    },
    memory: {
      ...(fileObject.memory && typeof fileObject.memory === "object" ? (fileObject.memory as object) : {}),
      autoSummariesEnabled:
        process.env.MOTTBOT_AUTO_MEMORY_SUMMARIES === undefined
          ? (fileObject.memory && typeof fileObject.memory === "object"
              ? (fileObject.memory as any).autoSummariesEnabled
              : undefined)
          : process.env.MOTTBOT_AUTO_MEMORY_SUMMARIES === "true",
      autoSummaryRecentMessages:
        process.env.MOTTBOT_AUTO_MEMORY_SUMMARY_RECENT_MESSAGES === undefined
          ? (fileObject.memory && typeof fileObject.memory === "object"
              ? (fileObject.memory as any).autoSummaryRecentMessages
              : undefined)
          : Number(process.env.MOTTBOT_AUTO_MEMORY_SUMMARY_RECENT_MESSAGES),
      autoSummaryMaxChars:
        process.env.MOTTBOT_AUTO_MEMORY_SUMMARY_MAX_CHARS === undefined
          ? (fileObject.memory && typeof fileObject.memory === "object"
              ? (fileObject.memory as any).autoSummaryMaxChars
              : undefined)
          : Number(process.env.MOTTBOT_AUTO_MEMORY_SUMMARY_MAX_CHARS),
      candidateExtractionEnabled:
        process.env.MOTTBOT_MEMORY_CANDIDATES_ENABLED === undefined
          ? (fileObject.memory && typeof fileObject.memory === "object"
              ? (fileObject.memory as any).candidateExtractionEnabled
              : undefined)
          : process.env.MOTTBOT_MEMORY_CANDIDATES_ENABLED === "true",
      candidateRecentMessages:
        process.env.MOTTBOT_MEMORY_CANDIDATE_RECENT_MESSAGES === undefined
          ? (fileObject.memory && typeof fileObject.memory === "object"
              ? (fileObject.memory as any).candidateRecentMessages
              : undefined)
          : Number(process.env.MOTTBOT_MEMORY_CANDIDATE_RECENT_MESSAGES),
      candidateMaxPerRun:
        process.env.MOTTBOT_MEMORY_CANDIDATE_MAX_PER_RUN === undefined
          ? (fileObject.memory && typeof fileObject.memory === "object"
              ? (fileObject.memory as any).candidateMaxPerRun
              : undefined)
          : Number(process.env.MOTTBOT_MEMORY_CANDIDATE_MAX_PER_RUN),
    },
  });

  const botToken = process.env[parsed.telegram.botTokenEnv]?.trim();
  if (!botToken) {
    throw new Error(`Missing Telegram bot token in env var ${parsed.telegram.botTokenEnv}.`);
  }

  const masterKey = process.env.MOTTBOT_MASTER_KEY?.trim();
  if (!masterKey) {
    throw new Error("Missing MOTTBOT_MASTER_KEY.");
  }

  return {
    configPath,
    telegram: {
      botToken,
      botTokenEnv: parsed.telegram.botTokenEnv,
      polling: parsed.telegram.polling,
      adminUserIds: parsed.telegram.adminUserIds,
      allowedChatIds: parsed.telegram.allowedChatIds,
      webhook: parsed.telegram.webhook,
      reactions: parsed.telegram.reactions,
    },
    models: parsed.models,
    auth: parsed.auth,
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
    security: {
      masterKey,
    },
  };
}
