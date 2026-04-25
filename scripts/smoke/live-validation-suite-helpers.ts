import {
  booleanFlag,
  parseCliArgs,
  positiveIntegerFlag,
  pushBooleanFlag,
  pushNumberFlag,
  pushStringFlag,
  stringFlag,
  stringListFlag,
} from "./cli-args.js";
import { normalizeBotUsername, type TelegramUserSmokeOptions } from "./telegram-user-smoke-helpers.js";

/** Supported live validation scenario categories. */
export type LiveValidationScenarioKind =
  | "preflight"
  | "private"
  | "health"
  | "usage"
  | "reply"
  | "group_mention"
  | "group_unmentioned"
  | "file";

/** CLI options consumed by live validation planning helpers. */
export type LiveValidationOptions = TelegramUserSmokeOptions & {
  dryRun?: boolean;
  scenarios?: string[];
  requireUserSmoke?: boolean;
  includeUserSmoke?: boolean;
  testChatId?: string;
  testMessage?: string;
  privateTarget?: string;
  privateMessage?: string;
  replyMessage?: string;
  groupTarget?: string;
  groupMessage?: string;
  groupUnmentionedMessage?: string;
  noReplyTimeoutMs?: number;
  filePaths?: string[];
  fileTarget?: string;
  fileMessage?: string;
  fileExpectReplyContains?: string;
};

/** One script invocation planned for live validation. */
export type LiveValidationScenario = {
  kind: LiveValidationScenarioKind;
  name: string;
  script: "smoke:preflight" | "smoke:telegram-user";
  args: string[];
};

/** Planned live validation scenarios plus skip and blocking-issue metadata. */
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
const DEFAULT_GROUP_UNMENTIONED_MESSAGE = "Live validation unmentioned group message; the bot should ignore this.";
const DEFAULT_NO_REPLY_TIMEOUT_MS = 15_000;

/** Builds live validation options from CLI flags. */
export function parseLiveValidationOptions(argv: readonly string[]): LiveValidationOptions {
  const args = parseCliArgs(argv);
  const scenarios = [...stringListFlag(args, "scenario"), ...stringListFlag(args, "scenarios")];
  const filePaths = [...stringListFlag(args, "file-path"), ...stringListFlag(args, "file-paths")];
  return {
    dryRun: booleanFlag(args, "dry-run", false),
    ...(scenarios.length > 0 ? { scenarios } : {}),
    requireUserSmoke: booleanFlag(args, "require-user-smoke", false),
    includeUserSmoke: booleanFlag(args, "include-user-smoke", true),
    ...(stringFlag(args, "test-chat-id") ? { testChatId: stringFlag(args, "test-chat-id") } : {}),
    ...(stringFlag(args, "test-message") ? { testMessage: stringFlag(args, "test-message") } : {}),
    ...(positiveIntegerFlag(args, "api-id") ? { apiId: positiveIntegerFlag(args, "api-id") } : {}),
    ...(stringFlag(args, "api-hash") ? { apiHash: stringFlag(args, "api-hash") } : {}),
    ...(stringFlag(args, "bot-username") ? { botUsername: stringFlag(args, "bot-username") } : {}),
    ...(stringFlag(args, "phone-number") ? { phoneNumber: stringFlag(args, "phone-number") } : {}),
    ...(stringFlag(args, "login-code") ? { loginCode: stringFlag(args, "login-code") } : {}),
    ...(stringFlag(args, "two-factor-password") ? { twoFactorPassword: stringFlag(args, "two-factor-password") } : {}),
    ...(stringFlag(args, "user-session") ? { userSession: stringFlag(args, "user-session") } : {}),
    ...(stringFlag(args, "session-path") ? { sessionPath: stringFlag(args, "session-path") } : {}),
    timeoutMs: positiveIntegerFlag(args, "timeout-ms"),
    pollIntervalMs: positiveIntegerFlag(args, "poll-interval-ms"),
    stableReplyMs: positiveIntegerFlag(args, "stable-reply-ms"),
    ...(stringFlag(args, "private-target") ? { privateTarget: stringFlag(args, "private-target") } : {}),
    ...(stringFlag(args, "private-message") ? { privateMessage: stringFlag(args, "private-message") } : {}),
    ...(stringFlag(args, "reply-message") ? { replyMessage: stringFlag(args, "reply-message") } : {}),
    ...(stringFlag(args, "group-target") ? { groupTarget: stringFlag(args, "group-target") } : {}),
    ...(stringFlag(args, "group-message") ? { groupMessage: stringFlag(args, "group-message") } : {}),
    ...(stringFlag(args, "group-unmentioned-message")
      ? { groupUnmentionedMessage: stringFlag(args, "group-unmentioned-message") }
      : {}),
    noReplyTimeoutMs: positiveIntegerFlag(args, "no-reply-timeout-ms"),
    ...(filePaths.length > 0 ? { filePaths } : {}),
    ...(stringFlag(args, "file-target") ? { fileTarget: stringFlag(args, "file-target") } : {}),
    ...(stringFlag(args, "file-message") ? { fileMessage: stringFlag(args, "file-message") } : {}),
    ...(stringFlag(args, "file-expect-reply-contains")
      ? { fileExpectReplyContains: stringFlag(args, "file-expect-reply-contains") }
      : {}),
    forceDocument: booleanFlag(args, "force-document", false),
  };
}

function selectedScenarios(options: LiveValidationOptions): Set<string> | undefined {
  const selected = options.scenarios?.map((item) => item.trim()).filter(Boolean) ?? [];
  return selected.length > 0 ? new Set(selected.map((item) => item.toLowerCase())) : undefined;
}

function isSelected(selected: Set<string> | undefined, kind: LiveValidationScenarioKind): boolean {
  return !selected || selected.has(kind) || (kind === "file" && selected.has("files"));
}

function userSmokeBaseArgs(options: LiveValidationOptions, botUsername: string): string[] {
  const args: string[] = [];
  pushNumberFlag(args, "api-id", options.apiId);
  pushStringFlag(args, "api-hash", options.apiHash);
  pushStringFlag(args, "bot-username", botUsername);
  pushStringFlag(args, "phone-number", options.phoneNumber);
  pushStringFlag(args, "login-code", options.loginCode);
  pushStringFlag(args, "two-factor-password", options.twoFactorPassword);
  pushStringFlag(args, "user-session", options.userSession);
  pushStringFlag(args, "session-path", options.sessionPath);
  pushNumberFlag(args, "timeout-ms", options.timeoutMs);
  pushNumberFlag(args, "poll-interval-ms", options.pollIntervalMs);
  pushNumberFlag(args, "stable-reply-ms", options.stableReplyMs);
  return args;
}

function scenario(params: {
  kind: LiveValidationScenarioKind;
  name: string;
  script: LiveValidationScenario["script"];
  args: string[];
}): LiveValidationScenario {
  return {
    kind: params.kind,
    name: params.name,
    script: params.script,
    args: params.args,
  };
}

/** Builds a live validation plan from CLI options and Telegram credentials. */
export function buildLiveValidationPlan(options: LiveValidationOptions): LiveValidationPlan {
  const enabled = true;
  const scenarios: LiveValidationScenario[] = [];
  const skipped: string[] = [];
  const issues: string[] = [];
  const dryRun = options.dryRun ?? false;
  const selected = selectedScenarios(options);

  if (isSelected(selected, "preflight")) {
    const args: string[] = [];
    pushStringFlag(args, "test-chat-id", options.testChatId);
    pushStringFlag(args, "test-message", options.testMessage);
    scenarios.push(
      scenario({
        kind: "preflight",
        name: "Live preflight",
        script: "smoke:preflight",
        args,
      }),
    );
  } else {
    skipped.push("preflight excluded by --scenario.");
  }

  const hasUserCredentials = Boolean(options.apiId && options.apiHash?.trim());
  const requireUserSmoke = options.requireUserSmoke ?? false;
  const includeUserSmoke = options.includeUserSmoke ?? true;
  const userScenarioRequested =
    !selected ||
    ["private", "health", "usage", "reply", "group_mention", "group_unmentioned", "file", "files"].some((kind) =>
      selected.has(kind),
    );
  if (!includeUserSmoke) {
    skipped.push("user-account smoke scenarios disabled by --no-include-user-smoke.");
    return { enabled, dryRun, scenarios, skipped, issues };
  }
  if (!userScenarioRequested) {
    return { enabled, dryRun, scenarios, skipped, issues };
  }
  if (!hasUserCredentials) {
    const reason = "--api-id and --api-hash are required for user-account smoke scenarios.";
    if (requireUserSmoke) {
      issues.push(reason);
    } else {
      skipped.push(reason);
    }
    return { enabled, dryRun, scenarios, skipped, issues };
  }

  const botUsername = normalizeBotUsername(options.botUsername ?? DEFAULT_BOT_USERNAME);
  const base = userSmokeBaseArgs(options, botUsername);
  const privateTarget = options.privateTarget?.trim() || botUsername;
  if (isSelected(selected, "private")) {
    const args = [...base];
    pushStringFlag(args, "target", privateTarget);
    pushStringFlag(args, "message", options.privateMessage?.trim() || DEFAULT_PRIVATE_MESSAGE);
    scenarios.push(
      scenario({
        kind: "private",
        name: "Private model conversation",
        script: "smoke:telegram-user",
        args,
      }),
    );
  }
  if (isSelected(selected, "health")) {
    const args = [...base];
    pushStringFlag(args, "target", privateTarget);
    pushStringFlag(args, "message", "/health");
    scenarios.push(
      scenario({
        kind: "health",
        name: "Private /health command",
        script: "smoke:telegram-user",
        args,
      }),
    );
  }
  if (isSelected(selected, "usage")) {
    const args = [...base];
    pushStringFlag(args, "target", privateTarget);
    pushStringFlag(args, "message", "/usage");
    scenarios.push(
      scenario({
        kind: "usage",
        name: "Private /usage command",
        script: "smoke:telegram-user",
        args,
      }),
    );
  }
  if (isSelected(selected, "reply")) {
    const args = [...base];
    pushStringFlag(args, "target", privateTarget);
    pushStringFlag(args, "message", options.replyMessage?.trim() || DEFAULT_REPLY_MESSAGE);
    pushBooleanFlag(args, "reply-to-latest-bot-message", true, false);
    scenarios.push(
      scenario({
        kind: "reply",
        name: "Reply-to-latest-bot-message conversation",
        script: "smoke:telegram-user",
        args,
      }),
    );
  }

  const groupTarget = options.groupTarget?.trim();
  if (groupTarget && isSelected(selected, "group_mention")) {
    const args = [...base];
    pushStringFlag(args, "target", groupTarget);
    pushStringFlag(
      args,
      "message",
      options.groupMessage?.trim() || `@${botUsername} run a short live validation health reply.`,
    );
    scenarios.push(
      scenario({
        kind: "group_mention",
        name: "Group mention conversation",
        script: "smoke:telegram-user",
        args,
      }),
    );
  } else if (!groupTarget && isSelected(selected, "group_mention")) {
    skipped.push("group_mention requires --group-target.");
  }
  if (groupTarget && isSelected(selected, "group_unmentioned")) {
    const args = [...base];
    pushStringFlag(args, "target", groupTarget);
    pushStringFlag(args, "message", options.groupUnmentionedMessage?.trim() || DEFAULT_GROUP_UNMENTIONED_MESSAGE);
    pushBooleanFlag(args, "expect-reply", false, true);
    pushNumberFlag(args, "timeout-ms", options.noReplyTimeoutMs ?? options.timeoutMs ?? DEFAULT_NO_REPLY_TIMEOUT_MS);
    scenarios.push(
      scenario({
        kind: "group_unmentioned",
        name: "Group unmentioned ignore check",
        script: "smoke:telegram-user",
        args,
      }),
    );
  } else if (!groupTarget && isSelected(selected, "group_unmentioned")) {
    skipped.push("group_unmentioned requires --group-target.");
  }

  const filePaths = options.filePaths ?? [];
  if (filePaths.length > 0 && isSelected(selected, "file")) {
    filePaths.forEach((filePath, index) => {
      const args = [...base];
      pushStringFlag(args, "target", options.fileTarget?.trim() || privateTarget);
      pushStringFlag(args, "file-path", filePath);
      pushStringFlag(args, "message", options.fileMessage?.trim() || DEFAULT_FILE_MESSAGE);
      pushStringFlag(args, "expect-reply-contains", options.fileExpectReplyContains);
      pushBooleanFlag(args, "force-document", options.forceDocument, false);
      scenarios.push(
        scenario({
          kind: "file",
          name: `Attachment fixture ${index + 1}`,
          script: "smoke:telegram-user",
          args,
        }),
      );
    });
  } else if (filePaths.length === 0 && isSelected(selected, "file")) {
    skipped.push("file scenarios require --file-path.");
  }

  return { enabled, dryRun, scenarios, skipped, issues };
}
