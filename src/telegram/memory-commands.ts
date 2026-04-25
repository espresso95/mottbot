import type { Api } from "grammy";
import type { MemoryStore, MemoryScope, MemoryCandidateStatus } from "../sessions/memory-store.js";
import type { MemoryCandidate } from "../sessions/memory-store.js";
import { isMemoryCandidateStatus, isMemoryScope, resolveMemoryScopeKey } from "../sessions/memory-store.js";
import type { SessionRoute } from "../sessions/types.js";
import { formatMemoryCandidate, formatMemoryRecord } from "./command-formatters.js";
import { normalizeFreeText, normalizeSingleArg } from "./command-parsing.js";
import { sendReply, type TelegramInlineKeyboard } from "./command-replies.js";
import {
  buildMemoryCandidateAcceptCallbackData,
  buildMemoryCandidateArchiveCallbackData,
  buildMemoryCandidateRejectCallbackData,
} from "./callback-data.js";
import type { TelegramGovernanceStore } from "./governance.js";
import type { InboundEvent, TelegramCallbackEvent } from "./types.js";

/** Dependencies needed by memory-related Telegram command handlers. */
type MemoryCommandDependencies = {
  api: Api;
  event: InboundEvent;
  session: SessionRoute;
  args: string[];
  memories?: MemoryStore;
  governance?: TelegramGovernanceStore;
};

/** Dependencies needed by memory candidate callback buttons. */
type MemoryCandidateCallbackDependencies = {
  api: Api;
  event: TelegramCallbackEvent;
  session: SessionRoute;
  memories?: MemoryStore;
  governance?: TelegramGovernanceStore;
};

/** Supported inline-button actions for one pending memory candidate. */
type MemoryCandidateCallbackAction = "accept" | "reject" | "archive";

function memoryCandidateKeyboard(candidates: readonly MemoryCandidate[]): TelegramInlineKeyboard | undefined {
  const rows = candidates.flatMap((candidate) => {
    if (candidate.status !== "pending") {
      return [];
    }
    const label = candidate.id.slice(0, 8);
    return [
      [
        {
          text: `Accept ${label}`,
          callback_data: buildMemoryCandidateAcceptCallbackData(candidate.id),
        },
        {
          text: "Reject",
          callback_data: buildMemoryCandidateRejectCallbackData(candidate.id),
        },
        {
          text: "Archive",
          callback_data: buildMemoryCandidateArchiveCallbackData(candidate.id),
        },
      ],
    ];
  });
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

function callbackNotice(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function answerCallback(api: Api, event: TelegramCallbackEvent, text: string, showAlert = false): Promise<void> {
  await api.answerCallbackQuery(event.callbackQueryId, {
    text: callbackNotice(text),
    show_alert: showAlert,
  });
}

async function refreshCandidateKeyboard(
  api: Api,
  event: TelegramCallbackEvent,
  memories: MemoryStore,
  sessionKey: string,
): Promise<void> {
  try {
    const replyMarkup = memoryCandidateKeyboard(memories.listCandidates(sessionKey, "pending"));
    await api.editMessageReplyMarkup(event.chatId, event.messageId, {
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch {
    // The decision was already recorded; stale keyboard cleanup is best effort.
  }
}

/** Parses optional memory scope arguments accepted by /remember. */
function parseMemoryScopeArgs(
  session: SessionRoute,
  args: string[],
): { scope: MemoryScope; scopeKey: string; contentArgs: string[] } | { error: string } {
  const first = args[0];
  if (!first?.startsWith("scope:")) {
    return { scope: "session", scopeKey: session.sessionKey, contentArgs: args };
  }
  const parts = first.split(":");
  const scope = parts[1]?.trim().toLowerCase();
  if (!scope || !isMemoryScope(scope)) {
    return { error: "Usage: /remember [scope:session|personal|chat|group|project:<key>] <fact>" };
  }
  const explicitScopeKey = parts.length > 2 ? parts.slice(2).join(":") : undefined;
  const scopeKey = resolveMemoryScopeKey({
    context: session,
    scope,
    explicitScopeKey: scope === "project" ? explicitScopeKey : undefined,
  });
  if (!scopeKey) {
    return { error: `Cannot use ${scope} memory scope in this chat.` };
  }
  return {
    scope,
    scopeKey,
    contentArgs: args.slice(1),
  };
}

/** Handles /remember for approved user-entered memory. */
export async function handleRememberCommand(params: MemoryCommandDependencies): Promise<void> {
  const { api, event, session, args, memories, governance } = params;
  if (!memories) {
    await sendReply(api, event, "Memory is not available.");
    return;
  }
  const scoped = parseMemoryScopeArgs(session, args);
  if ("error" in scoped) {
    await sendReply(api, event, scoped.error);
    return;
  }
  if (governance && !governance.isMemoryScopeAllowed({ chatId: event.chatId, scope: scoped.scope })) {
    await sendReply(api, event, `Memory scope ${scoped.scope} is not allowed in this chat.`);
    return;
  }
  const contentText = normalizeFreeText(scoped.contentArgs);
  if (!contentText) {
    await sendReply(api, event, "Usage: /remember [scope:session|personal|chat|group|project:<key>] <fact>");
    return;
  }
  try {
    const memory = memories.add({
      sessionKey: session.sessionKey,
      contentText,
      scope: scoped.scope,
      scopeKey: scoped.scopeKey,
    });
    await sendReply(api, event, `Remembered ${memory.id.slice(0, 8)} for ${memory.scope} scope.`);
  } catch (error) {
    await sendReply(api, event, error instanceof Error ? error.message : String(error));
  }
}

/** Handles /memory inspection and candidate review subcommands. */
export async function handleMemoryCommand(params: MemoryCommandDependencies): Promise<void> {
  const { api, event, session, args, memories, governance } = params;
  if (!memories) {
    await sendReply(api, event, "Memory is not available.");
    return;
  }
  const sub = args[0]?.toLowerCase();
  if (!sub || sub === "list") {
    const records = memories.listForScopeContext(session);
    await sendReply(
      api,
      event,
      records.length > 0 ? ["Approved memory:", ...records.map(formatMemoryRecord)].join("\n") : "No approved memory.",
    );
    return;
  }
  if (sub === "candidates") {
    const requestedStatus = args[1]?.toLowerCase();
    const status: MemoryCandidateStatus | "all" =
      requestedStatus === "all"
        ? "all"
        : requestedStatus && isMemoryCandidateStatus(requestedStatus)
          ? requestedStatus
          : "pending";
    const candidates = memories.listCandidates(session.sessionKey, status);
    await sendReply(
      api,
      event,
      candidates.length > 0
        ? [`Memory candidates (${status}):`, ...candidates.map(formatMemoryCandidate)].join("\n")
        : `No ${status} memory candidates.`,
      {
        replyMarkup: status === "pending" ? memoryCandidateKeyboard(candidates) : undefined,
      },
    );
    return;
  }
  if (sub === "accept") {
    const prefix = normalizeSingleArg(args[1]);
    if (!prefix) {
      await sendReply(api, event, "Usage: /memory accept <candidate-id-prefix>");
      return;
    }
    const candidate = memories
      .listCandidates(session.sessionKey, "pending", 50)
      .filter((record) => record.id.startsWith(prefix));
    if (
      candidate.length === 1 &&
      candidate[0] &&
      governance &&
      !governance.isMemoryScopeAllowed({ chatId: event.chatId, scope: candidate[0].scope })
    ) {
      await sendReply(api, event, `Memory scope ${candidate[0].scope} is not allowed in this chat.`);
      return;
    }
    const accepted = memories.acceptCandidate({
      sessionKey: session.sessionKey,
      idPrefix: prefix,
      decidedByUserId: event.fromUserId,
    });
    await sendReply(
      api,
      event,
      accepted
        ? `Accepted ${accepted.memory.id.slice(0, 8)} for ${accepted.memory.scope} memory.`
        : "No pending candidate found.",
    );
    return;
  }
  if (sub === "reject") {
    const prefix = normalizeSingleArg(args[1]);
    if (!prefix) {
      await sendReply(api, event, "Usage: /memory reject <candidate-id-prefix>");
      return;
    }
    const rejected = memories.rejectCandidate(session.sessionKey, prefix, event.fromUserId);
    await sendReply(api, event, rejected ? "Candidate rejected." : "No pending candidate found.");
    return;
  }
  if (sub === "edit") {
    const prefix = normalizeSingleArg(args[1]);
    const contentText = normalizeFreeText(args.slice(2));
    if (!prefix || !contentText) {
      await sendReply(api, event, "Usage: /memory edit <candidate-id-prefix> <replacement fact>");
      return;
    }
    const updated = memories.updateCandidate(session.sessionKey, prefix, contentText);
    await sendReply(
      api,
      event,
      updated.updated
        ? `Candidate ${updated.candidate.id.slice(0, 8)} updated.`
        : updated.reason === "duplicate_candidate"
          ? "A pending candidate already has that memory."
          : updated.reason === "duplicate_memory"
            ? "Approved memory already has that content."
            : "No pending candidate found.",
    );
    return;
  }
  if (sub === "pin" || sub === "unpin") {
    const prefix = normalizeSingleArg(args[1]);
    if (!prefix) {
      await sendReply(api, event, `Usage: /memory ${sub} <memory-id-prefix>`);
      return;
    }
    const pinned = memories.pinForScopeContext(session, prefix, sub === "pin");
    await sendReply(
      api,
      event,
      pinned ? `Memory ${sub === "pin" ? "pinned" : "unpinned"}.` : "No matching memory found.",
    );
    return;
  }
  if (sub === "archive") {
    const targetType = args[1]?.toLowerCase();
    if (targetType === "candidate") {
      const prefix = normalizeSingleArg(args[2]);
      if (!prefix) {
        await sendReply(api, event, "Usage: /memory archive candidate <candidate-id-prefix>");
        return;
      }
      const archived = memories.archiveCandidate(session.sessionKey, prefix, event.fromUserId);
      await sendReply(api, event, archived ? "Candidate archived." : "No pending candidate found.");
      return;
    }
    const prefix = normalizeSingleArg(args[1]);
    if (!prefix) {
      await sendReply(api, event, "Usage: /memory archive <memory-id-prefix>");
      return;
    }
    const archived = memories.archiveForScopeContext(session, prefix);
    await sendReply(api, event, archived ? "Memory archived." : "No matching memory found.");
    return;
  }
  if (sub === "clear" && args[1]?.toLowerCase() === "candidates") {
    const removed = memories.clearCandidates(session.sessionKey);
    await sendReply(api, event, `Cleared ${removed} pending memory candidates.`);
    return;
  }
  await sendReply(
    api,
    event,
    "Usage: /memory [list] | candidates [status|all] | accept <id> | reject <id> | edit <id> <text> | pin <id> | unpin <id> | archive <id> | archive candidate <id> | clear candidates",
  );
}

/** Handles inline accept, reject, and archive buttons for model-proposed memory candidates. */
export async function handleMemoryCandidateCallback(
  params: MemoryCandidateCallbackDependencies,
  action: MemoryCandidateCallbackAction,
  candidateId: string,
): Promise<void> {
  const { api, event, session, memories, governance } = params;
  if (!memories) {
    await answerCallback(api, event, "Memory is not available.", true);
    await sendReply(api, event, "Memory is not available.");
    return;
  }
  const candidate = memories.getCandidate(session.sessionKey, candidateId);
  if (!candidate) {
    await answerCallback(api, event, "No memory candidate found for this session.", true);
    await sendReply(api, event, "No memory candidate found for this session.");
    return;
  }
  if (candidate.status !== "pending") {
    const message = `Memory candidate ${candidate.id.slice(0, 8)} is already ${candidate.status}.`;
    await refreshCandidateKeyboard(api, event, memories, session.sessionKey);
    await answerCallback(api, event, message);
    await sendReply(api, event, message);
    return;
  }
  if (
    action === "accept" &&
    governance &&
    !governance.isMemoryScopeAllowed({ chatId: event.chatId, scope: candidate.scope })
  ) {
    const message = `Memory scope ${candidate.scope} is not allowed in this chat.`;
    await answerCallback(api, event, message, true);
    await sendReply(api, event, message);
    return;
  }

  if (action === "accept") {
    const accepted = memories.acceptCandidate({
      sessionKey: session.sessionKey,
      idPrefix: candidate.id,
      decidedByUserId: event.fromUserId,
    });
    await refreshCandidateKeyboard(api, event, memories, session.sessionKey);
    const message = accepted
      ? `Accepted ${accepted.memory.id.slice(0, 8)} for ${accepted.memory.scope} memory.`
      : "No pending candidate found.";
    await answerCallback(api, event, message);
    await sendReply(api, event, message);
    return;
  }
  const decided =
    action === "reject"
      ? memories.rejectCandidate(session.sessionKey, candidate.id, event.fromUserId)
      : memories.archiveCandidate(session.sessionKey, candidate.id, event.fromUserId);
  await refreshCandidateKeyboard(api, event, memories, session.sessionKey);
  const message = decided
    ? action === "reject"
      ? "Candidate rejected."
      : "Candidate archived."
    : "No pending candidate found.";
  await answerCallback(api, event, message);
  await sendReply(api, event, message);
}

/** Handles /forget for approved session memory. */
export async function handleForgetCommand(params: MemoryCommandDependencies): Promise<void> {
  const { api, event, session, args, memories } = params;
  if (!memories) {
    await sendReply(api, event, "Memory is not available.");
    return;
  }
  const target = normalizeSingleArg(args[0]);
  if (!target) {
    await sendReply(api, event, "Usage: /forget <memory-id-prefix|all>");
    return;
  }
  if (target === "all") {
    const removed = memories.clearForScopeContext(session);
    await sendReply(api, event, `Forgot ${removed} memories.`);
    return;
  }
  if (target === "auto") {
    const removed = memories.clearForScopeContext(session, "auto_summary");
    await sendReply(api, event, `Forgot ${removed} automatic summaries.`);
    return;
  }
  const removed = memories.removeForScopeContext(session, target);
  await sendReply(api, event, removed ? "Memory forgotten." : "No matching memory found.");
}
