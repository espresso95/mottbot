import { normalizeBotUsername, parseBooleanEnv } from "./telegram-user-smoke-helpers.js";

export type LiveValidationEnv = Record<string, string | undefined>;

export type LiveValidationScenarioKind =
  | "preflight"
  | "private"
  | "health"
  | "usage"
  | "reply"
  | "group_mention"
  | "file";

export type LiveValidationScenario = {
  kind: LiveValidationScenarioKind;
  name: string;
  script: "smoke:preflight" | "smoke:telegram-user";
  env: Record<string, string>;
};

export type LiveValidationPlan = {
  enabled: boolean;
  dryRun: boolean;
  scenarios: LiveValidationScenario[];
  skipped: string[];
  issues: string[];
};

const DEFAULT_BOT_USERNAME = "StartupMottBot";
const DEFAULT_PRIVATE_MESSAGE = "Use your health snapshot tool and reply with one concise status sentence.";
const DEFAULT_REPLY_MESSAGE = "Reply with one short acknowledgement for live validation.";
const DEFAULT_FILE_MESSAGE = "Summarize this live validation attachment in one sentence.";

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectedScenarios(env: LiveValidationEnv): Set<string> | undefined {
  const selected = splitList(env.MOTTBOT_LIVE_VALIDATION_SCENARIOS);
  return selected.length > 0 ? new Set(selected.map((item) => item.toLowerCase())) : undefined;
}

function isSelected(selected: Set<string> | undefined, kind: LiveValidationScenarioKind): boolean {
  return !selected || selected.has(kind) || (kind === "file" && selected.has("files"));
}

function userSmokeBaseEnv(env: LiveValidationEnv): Record<string, string> {
  const apiId = env.TELEGRAM_API_ID?.trim();
  const apiHash = env.TELEGRAM_API_HASH?.trim();
  const botUsername = normalizeBotUsername(env.MOTTBOT_LIVE_BOT_USERNAME ?? DEFAULT_BOT_USERNAME);
  return {
    MOTTBOT_LIVE_BOT_USERNAME: botUsername,
    MOTTBOT_USER_SMOKE_WAIT_FOR_REPLY: "true",
    ...(apiId ? { TELEGRAM_API_ID: apiId } : {}),
    ...(apiHash ? { TELEGRAM_API_HASH: apiHash } : {}),
    ...(env.TELEGRAM_USER_SESSION?.trim() ? { TELEGRAM_USER_SESSION: env.TELEGRAM_USER_SESSION.trim() } : {}),
    ...(env.TELEGRAM_PHONE_NUMBER?.trim() ? { TELEGRAM_PHONE_NUMBER: env.TELEGRAM_PHONE_NUMBER.trim() } : {}),
    ...(env.TELEGRAM_LOGIN_CODE?.trim() ? { TELEGRAM_LOGIN_CODE: env.TELEGRAM_LOGIN_CODE.trim() } : {}),
    ...(env.TELEGRAM_2FA_PASSWORD?.trim() ? { TELEGRAM_2FA_PASSWORD: env.TELEGRAM_2FA_PASSWORD.trim() } : {}),
    ...(env.MOTTBOT_USER_SMOKE_SESSION_PATH?.trim()
      ? { MOTTBOT_USER_SMOKE_SESSION_PATH: env.MOTTBOT_USER_SMOKE_SESSION_PATH.trim() }
      : {}),
    ...(env.MOTTBOT_USER_SMOKE_TIMEOUT_MS?.trim()
      ? { MOTTBOT_USER_SMOKE_TIMEOUT_MS: env.MOTTBOT_USER_SMOKE_TIMEOUT_MS.trim() }
      : {}),
    ...(env.MOTTBOT_USER_SMOKE_POLL_INTERVAL_MS?.trim()
      ? { MOTTBOT_USER_SMOKE_POLL_INTERVAL_MS: env.MOTTBOT_USER_SMOKE_POLL_INTERVAL_MS.trim() }
      : {}),
    ...(env.MOTTBOT_USER_SMOKE_STABLE_REPLY_MS?.trim()
      ? { MOTTBOT_USER_SMOKE_STABLE_REPLY_MS: env.MOTTBOT_USER_SMOKE_STABLE_REPLY_MS.trim() }
      : {}),
  };
}

function scenario(params: {
  kind: LiveValidationScenarioKind;
  name: string;
  script: LiveValidationScenario["script"];
  env: Record<string, string>;
}): LiveValidationScenario {
  return {
    kind: params.kind,
    name: params.name,
    script: params.script,
    env: params.env,
  };
}

export function buildLiveValidationPlan(env: LiveValidationEnv): LiveValidationPlan {
  const enabled = true;
  const scenarios: LiveValidationScenario[] = [];
  const skipped: string[] = [];
  const issues: string[] = [];
  const dryRun = parseBooleanEnv(env, "MOTTBOT_LIVE_VALIDATION_DRY_RUN", false);
  const selected = selectedScenarios(env);

  if (isSelected(selected, "preflight")) {
    scenarios.push(
      scenario({
        kind: "preflight",
        name: "Live preflight",
        script: "smoke:preflight",
        env: {},
      }),
    );
  } else {
    skipped.push("preflight excluded by MOTTBOT_LIVE_VALIDATION_SCENARIOS.");
  }

  const hasUserCredentials = Boolean(env.TELEGRAM_API_ID?.trim() && env.TELEGRAM_API_HASH?.trim());
  const requireUserSmoke = parseBooleanEnv(env, "MOTTBOT_LIVE_VALIDATION_REQUIRE_USER_SMOKE", false);
  const includeUserSmoke = parseBooleanEnv(env, "MOTTBOT_LIVE_VALIDATION_INCLUDE_USER_SMOKE", true);
  const userScenarioRequested =
    !selected ||
    ["private", "health", "usage", "reply", "group_mention", "file", "files"].some((kind) => selected.has(kind));
  if (!includeUserSmoke) {
    skipped.push("user-account smoke scenarios disabled by MOTTBOT_LIVE_VALIDATION_INCLUDE_USER_SMOKE=false.");
    return { enabled, dryRun, scenarios, skipped, issues };
  }
  if (!userScenarioRequested) {
    return { enabled, dryRun, scenarios, skipped, issues };
  }
  if (!hasUserCredentials) {
    const reason = "TELEGRAM_API_ID and TELEGRAM_API_HASH are required for user-account smoke scenarios.";
    if (requireUserSmoke) {
      issues.push(reason);
    } else {
      skipped.push(reason);
    }
    return { enabled, dryRun, scenarios, skipped, issues };
  }

  const base = userSmokeBaseEnv(env);
  const botUsername = base.MOTTBOT_LIVE_BOT_USERNAME;
  if (!botUsername) {
    throw new Error("MOTTBOT_LIVE_BOT_USERNAME was not resolved.");
  }
  const privateTarget = env.MOTTBOT_LIVE_VALIDATION_PRIVATE_TARGET?.trim() || botUsername;
  if (isSelected(selected, "private")) {
    scenarios.push(
      scenario({
        kind: "private",
        name: "Private model conversation",
        script: "smoke:telegram-user",
        env: {
          ...base,
          MOTTBOT_USER_SMOKE_TARGET: privateTarget,
          MOTTBOT_USER_SMOKE_MESSAGE:
            env.MOTTBOT_LIVE_VALIDATION_PRIVATE_MESSAGE?.trim() || DEFAULT_PRIVATE_MESSAGE,
        },
      }),
    );
  }
  if (isSelected(selected, "health")) {
    scenarios.push(
      scenario({
        kind: "health",
        name: "Private /health command",
        script: "smoke:telegram-user",
        env: {
          ...base,
          MOTTBOT_USER_SMOKE_TARGET: privateTarget,
          MOTTBOT_USER_SMOKE_MESSAGE: "/health",
        },
      }),
    );
  }
  if (isSelected(selected, "usage")) {
    scenarios.push(
      scenario({
        kind: "usage",
        name: "Private /usage command",
        script: "smoke:telegram-user",
        env: {
          ...base,
          MOTTBOT_USER_SMOKE_TARGET: privateTarget,
          MOTTBOT_USER_SMOKE_MESSAGE: "/usage",
        },
      }),
    );
  }
  if (isSelected(selected, "reply")) {
    scenarios.push(
      scenario({
        kind: "reply",
        name: "Reply-to-latest-bot-message conversation",
        script: "smoke:telegram-user",
        env: {
          ...base,
          MOTTBOT_USER_SMOKE_TARGET: privateTarget,
          MOTTBOT_USER_SMOKE_REPLY_TO_LATEST_BOT_MESSAGE: "true",
          MOTTBOT_USER_SMOKE_MESSAGE: env.MOTTBOT_LIVE_VALIDATION_REPLY_MESSAGE?.trim() || DEFAULT_REPLY_MESSAGE,
        },
      }),
    );
  }

  const groupTarget = env.MOTTBOT_LIVE_VALIDATION_GROUP_TARGET?.trim();
  if (groupTarget && isSelected(selected, "group_mention")) {
    scenarios.push(
      scenario({
        kind: "group_mention",
        name: "Group mention conversation",
        script: "smoke:telegram-user",
        env: {
          ...base,
          MOTTBOT_USER_SMOKE_TARGET: groupTarget,
          MOTTBOT_USER_SMOKE_MESSAGE:
            env.MOTTBOT_LIVE_VALIDATION_GROUP_MESSAGE?.trim() ||
            `@${botUsername} run a short live validation health reply.`,
        },
      }),
    );
  } else if (!groupTarget && isSelected(selected, "group_mention")) {
    skipped.push("group_mention requires MOTTBOT_LIVE_VALIDATION_GROUP_TARGET.");
  }

  const filePaths = splitList(env.MOTTBOT_LIVE_VALIDATION_FILE_PATHS);
  if (filePaths.length > 0 && isSelected(selected, "file")) {
    filePaths.forEach((filePath, index) => {
      scenarios.push(
        scenario({
          kind: "file",
          name: `Attachment fixture ${index + 1}`,
          script: "smoke:telegram-user",
          env: {
            ...base,
            MOTTBOT_USER_SMOKE_TARGET: env.MOTTBOT_LIVE_VALIDATION_FILE_TARGET?.trim() || privateTarget,
            MOTTBOT_USER_SMOKE_FILE_PATH: filePath,
            MOTTBOT_USER_SMOKE_MESSAGE: env.MOTTBOT_LIVE_VALIDATION_FILE_MESSAGE?.trim() || DEFAULT_FILE_MESSAGE,
            ...(parseBooleanEnv(env, "MOTTBOT_LIVE_VALIDATION_FORCE_DOCUMENT", false)
              ? { MOTTBOT_USER_SMOKE_FORCE_DOCUMENT: "true" }
              : {}),
          },
        }),
      );
    });
  } else if (filePaths.length === 0 && isSelected(selected, "file")) {
    skipped.push("file scenarios require MOTTBOT_LIVE_VALIDATION_FILE_PATHS.");
  }

  return { enabled, dryRun, scenarios, skipped, issues };
}
