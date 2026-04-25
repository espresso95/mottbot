import type { Api } from "grammy";
import type { AuthProfileStore } from "../codex/auth-store.js";
import { isKnownCodexModelRef, KNOWN_CODEX_MODEL_REFS_TEXT } from "../codex/provider.js";
import type { CodexTokenResolver } from "../codex/token-resolver.js";
import { fetchCodexUsage } from "../codex/usage.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";
import type { UsageBudgetService } from "../runs/usage-budget.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { SessionRoute } from "../sessions/types.js";
import { formatUsageSummary } from "./command-formatters.js";
import {
  PROFILE_ID_PATTERN,
  normalizeBindingName,
  normalizeSingleArg,
  validateBindingName,
} from "./command-parsing.js";
import { sendReply } from "./command-replies.js";
import type { TelegramGovernanceStore } from "./governance.js";
import type { InboundEvent } from "./types.js";

type SessionCommandBaseDependencies = {
  api: Api;
  event: InboundEvent;
  session: SessionRoute;
};

/** Dependencies needed by the Telegram session status command handler. */
type StatusCommandDependencies = SessionCommandBaseDependencies & {
  authProfiles: AuthProfileStore;
  tokenResolver: CodexTokenResolver;
};

/** Dependencies needed by the Telegram local usage command handler. */
type UsageCommandDependencies = SessionCommandBaseDependencies & {
  args: string[];
  usageBudget?: UsageBudgetService;
};

/** Dependencies needed by the Telegram model selection command handler. */
type ModelCommandDependencies = SessionCommandBaseDependencies & {
  args: string[];
  sessions: SessionStore;
  governance?: TelegramGovernanceStore;
};

/** Dependencies needed by the Telegram auth profile selection command handler. */
type ProfileCommandDependencies = SessionCommandBaseDependencies & {
  args: string[];
  sessions: SessionStore;
  authProfiles: AuthProfileStore;
};

/** Dependencies needed by the Telegram fast-mode command handler. */
type FastCommandDependencies = SessionCommandBaseDependencies & {
  args: string[];
  sessions: SessionStore;
};

/** Dependencies needed by the Telegram transcript reset command handler. */
type ResetCommandDependencies = SessionCommandBaseDependencies & {
  transcripts: TranscriptStore;
};

/** Dependencies needed by the Telegram run cancellation command handler. */
type StopCommandDependencies = SessionCommandBaseDependencies & {
  orchestrator: RunOrchestrator;
};

/** Dependencies needed by the Telegram route binding command handler. */
type BindCommandDependencies = SessionCommandBaseDependencies & {
  args: string[];
  sessions: SessionStore;
};

/** Dependencies needed by the Telegram route unbinding command handler. */
type UnbindCommandDependencies = SessionCommandBaseDependencies & {
  sessions: SessionStore;
};

/** Handles /status by reporting the current route, auth profile count, and subscription usage. */
export async function handleStatusCommand(params: StatusCommandDependencies): Promise<void> {
  const { api, authProfiles, event, session, tokenResolver } = params;
  const authCount = authProfiles.list().length;
  let usageSummary = "Usage unavailable";
  try {
    const auth = await tokenResolver.resolve(session.profileId);
    const usage = await fetchCodexUsage({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
    });
    usageSummary = formatUsageSummary(usage);
  } catch {
    // Keep status usable when auth or remote usage lookup fails.
  }
  await sendReply(
    api,
    event,
    [
      `Session: ${session.sessionKey}`,
      `Agent: ${session.agentId}`,
      `Model: ${session.modelRef}`,
      `Profile: ${session.profileId}`,
      `Fast mode: ${session.fastMode ? "on" : "off"}`,
      `Auth profiles: ${authCount}`,
      `Usage: ${usageSummary}`,
    ].join("\n"),
  );
}

/** Handles /usage daily and monthly local run-budget reporting. */
export async function handleUsageCommand(params: UsageCommandDependencies): Promise<void> {
  const { api, event, session, args, usageBudget } = params;
  if (!usageBudget) {
    await sendReply(api, event, "Usage budgets are not available.");
    return;
  }
  const selectedWindow = args[0]?.toLowerCase();
  if (selectedWindow && selectedWindow !== "daily" && selectedWindow !== "monthly") {
    await sendReply(api, event, "Usage: /usage [daily|monthly]");
    return;
  }
  const window = selectedWindow === "monthly" ? "monthly" : "daily";
  await sendReply(api, event, usageBudget.formatUsageReport({ session, window }));
}

/** Handles /model validation, governance checks, and session model updates. */
export async function handleModelCommand(params: ModelCommandDependencies): Promise<void> {
  const { api, event, session, args, governance, sessions } = params;
  const nextModelRef = normalizeSingleArg(args[0]);
  if (!nextModelRef) {
    await sendReply(api, event, "Usage: /model <provider/model>");
    return;
  }
  if (!isKnownCodexModelRef(nextModelRef)) {
    await sendReply(api, event, `Unknown model ${nextModelRef}. Supported models: ${KNOWN_CODEX_MODEL_REFS_TEXT}.`);
    return;
  }
  if (governance && !governance.isModelAllowed({ chatId: event.chatId, modelRef: nextModelRef })) {
    await sendReply(api, event, `Model ${nextModelRef} is not allowed in this chat.`);
    return;
  }
  sessions.setModelRef(session.sessionKey, nextModelRef);
  await sendReply(api, event, `Model set to ${nextModelRef}.`);
}

/** Handles /profile listing, validation, and session profile updates. */
export async function handleProfileCommand(params: ProfileCommandDependencies): Promise<void> {
  const { api, authProfiles, event, session, args, sessions } = params;
  const nextProfileId = normalizeSingleArg(args[0]);
  if (!nextProfileId) {
    const profiles = authProfiles.list();
    await sendReply(
      api,
      event,
      profiles.length > 0
        ? `Profiles:\n${profiles.map((profile) => `- ${profile.profileId} (${profile.source})`).join("\n")}`
        : "No auth profiles found.",
    );
    return;
  }
  if (!PROFILE_ID_PATTERN.test(nextProfileId)) {
    await sendReply(
      api,
      event,
      "Invalid profile ID. Use 1-128 letters, numbers, dots, slashes, underscores, colons, or hyphens.",
    );
    return;
  }
  if (!authProfiles.get(nextProfileId)) {
    await sendReply(api, event, `Unknown profile ${nextProfileId}.`);
    return;
  }
  sessions.setProfileId(session.sessionKey, nextProfileId);
  await sendReply(api, event, `Profile set to ${nextProfileId}.`);
}

/** Handles /fast on and off session priority toggles. */
export async function handleFastCommand(params: FastCommandDependencies): Promise<void> {
  const { api, event, session, args, sessions } = params;
  if (!args[0] || !["on", "off"].includes(args[0])) {
    await sendReply(api, event, "Usage: /fast on|off");
    return;
  }
  const next = args[0] === "on";
  sessions.setFastMode(session.sessionKey, next);
  await sendReply(api, event, `Fast mode ${next ? "enabled" : "disabled"}.`);
}

/** Handles /new and /reset transcript cleanup for the current session. */
export async function handleResetCommand(params: ResetCommandDependencies): Promise<void> {
  const { api, event, session, transcripts } = params;
  transcripts.clearSession(session.sessionKey);
  await sendReply(api, event, "Session transcript cleared.");
}

/** Handles /stop cancellation for the active run in the current session. */
export async function handleStopCommand(params: StopCommandDependencies): Promise<void> {
  const { api, event, session, orchestrator } = params;
  const stopped = await orchestrator.stop(session.sessionKey);
  await sendReply(api, event, stopped ? "Active run cancelled." : "No active run.");
}

/** Handles /bind route persistence for always-on replies in the current chat or topic. */
export async function handleBindCommand(params: BindCommandDependencies): Promise<void> {
  const { api, event, session, args, sessions } = params;
  const bindingName = normalizeBindingName(args);
  if (!validateBindingName(bindingName)) {
    await sendReply(api, event, "Invalid binding name. Use 1-64 visible characters.");
    return;
  }
  sessions.bind(session.sessionKey, bindingName);
  await sendReply(api, event, "Route bound for always-on replies in this chat/topic.");
}

/** Handles /unbind by restoring default route behavior for the current session. */
export async function handleUnbindCommand(params: UnbindCommandDependencies): Promise<void> {
  const { api, event, session, sessions } = params;
  sessions.unbind(session.sessionKey);
  await sendReply(api, event, "Route unbound.");
}
