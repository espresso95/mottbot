import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { fileExists } from "../shared/fs.js";

dotenv.config();

const transportSchema = z.enum(["auto", "sse", "websocket"]);

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
  behavior: z
    .object({
      respondInGroupsOnlyWhenMentioned: z.boolean().default(true),
      editThrottleMs: z.number().int().min(250).default(750),
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
  behavior: {
    respondInGroupsOnlyWhenMentioned: boolean;
    editThrottleMs: number;
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

function readConfigFile(configPath: string): unknown {
  if (!fileExists(configPath)) {
    return {};
  }
  const raw = fs.readFileSync(configPath, "utf8");
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
    },
    models: parsed.models,
    auth: parsed.auth,
    storage: {
      sqlitePath: path.resolve(parsed.storage.sqlitePath),
    },
    behavior: parsed.behavior,
    logging: parsed.logging,
    oauth: parsed.oauth,
    dashboard: parsed.dashboard,
    security: {
      masterKey,
    },
  };
}
