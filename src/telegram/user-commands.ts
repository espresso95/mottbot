import type { Api } from "grammy";
import { formatChatPolicy, formatGovernanceAuditRecord, formatRoleRecord } from "./command-formatters.js";
import { normalizeFreeText, normalizeSingleArg, parseBoundedLimit } from "./command-parsing.js";
import { sendReply } from "./command-replies.js";
import {
  parseChatGovernancePolicy,
  parseTelegramUserRole,
  type ChatGovernancePolicy,
  type TelegramGovernanceStore,
  type TelegramUserRole,
} from "./governance.js";
import type { InboundEvent } from "./types.js";

/** Dependencies needed by the Telegram user governance command handler. */
type UserCommandDependencies = {
  api: Api;
  event: InboundEvent;
  args: string[];
  governance?: TelegramGovernanceStore;
  role: TelegramUserRole;
  isAdmin: boolean;
  isOwner: boolean;
};

async function requireAdmin(params: UserCommandDependencies, action: string): Promise<boolean> {
  if (params.isAdmin) {
    return true;
  }
  await sendReply(params.api, params.event, `Only owner/admin roles can ${action}.`);
  return false;
}

async function requireOwner(params: UserCommandDependencies, action: string): Promise<boolean> {
  if (params.isOwner) {
    return true;
  }
  await sendReply(params.api, params.event, `Only owner roles can ${action}.`);
  return false;
}

function parseChatPolicySetArgs(
  event: InboundEvent,
  args: string[],
): { chatId: string; policy: ChatGovernancePolicy } | { error: string } {
  const first = args[0];
  if (!first) {
    return { error: "Usage: /users chat set [chat-id] <json>" };
  }
  const jsonStartsAt = first.trim().startsWith("{") ? 0 : 1;
  const chatId = jsonStartsAt === 0 ? event.chatId : normalizeSingleArg(first);
  const rawJson = normalizeFreeText(args.slice(jsonStartsAt));
  if (!chatId || !rawJson) {
    return { error: "Usage: /users chat set [chat-id] <json>" };
  }
  try {
    return {
      chatId,
      policy: parseChatGovernancePolicy(rawJson),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Formats the user governance help text visible to the current caller. */
function formatUsersHelp(params: Pick<UserCommandDependencies, "isAdmin" | "isOwner">): string {
  const commands = [
    "/users me - show your role",
    ...(params.isAdmin
      ? [
          "/users list - list configured roles",
          "/users audit [limit] - inspect role and chat-policy audit records",
          "/users chat show [chat-id] - show chat policy",
        ]
      : []),
    ...(params.isOwner
      ? [
          "/users grant <user-id> <owner|admin|trusted> [reason] - grant a role",
          "/users revoke <user-id> [reason] - revoke a database role",
          "/users chat set [chat-id] <json> - set chat policy",
          "/users chat clear [chat-id] - clear chat policy",
        ]
      : []),
  ];
  return ["User governance", ...commands.map((command) => `- ${command}`)].join("\n");
}

async function handleUsersChatCommand(params: UserCommandDependencies): Promise<void> {
  const { api, event, args, governance } = params;
  if (!governance) {
    await sendReply(api, event, "User governance is not available.");
    return;
  }
  const sub = args[0]?.toLowerCase() ?? "show";
  if (sub === "show") {
    if (!(await requireAdmin(params, "inspect chat policy"))) {
      return;
    }
    const chatId = normalizeSingleArg(args[1]) ?? event.chatId;
    await sendReply(api, event, formatChatPolicy(governance.getChatPolicy(chatId), chatId));
    return;
  }
  if (sub === "set") {
    if (!(await requireOwner(params, "set chat policy"))) {
      return;
    }
    const parsed = parseChatPolicySetArgs(event, args.slice(1));
    if ("error" in parsed) {
      await sendReply(api, event, parsed.error);
      return;
    }
    try {
      const policy = governance.setChatPolicy({
        chatId: parsed.chatId,
        policy: parsed.policy,
        actorUserId: event.fromUserId,
      });
      await sendReply(api, event, formatChatPolicy(policy, parsed.chatId));
    } catch (error) {
      await sendReply(api, event, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (sub === "clear") {
    if (!(await requireOwner(params, "clear chat policy"))) {
      return;
    }
    const chatId = normalizeSingleArg(args[1]) ?? event.chatId;
    const cleared = governance.clearChatPolicy({ chatId, actorUserId: event.fromUserId });
    await sendReply(api, event, cleared ? `Cleared chat policy for ${chatId}.` : `No chat policy set for ${chatId}.`);
    return;
  }
  await sendReply(api, event, "Usage: /users chat show [chat-id] | set [chat-id] <json> | clear [chat-id]");
}

/** Handles /users role and chat-policy governance subcommands. */
export async function handleUsersCommand(params: UserCommandDependencies): Promise<void> {
  const { api, event, args, governance } = params;
  if (!governance) {
    await sendReply(api, event, "User governance is not available.");
    return;
  }
  const sub = args[0]?.toLowerCase() ?? "me";
  if (sub === "me") {
    await sendReply(api, event, `Your role: ${params.role}`);
    return;
  }
  if (sub === "list") {
    if (!(await requireAdmin(params, "list user roles"))) {
      return;
    }
    const roles = governance.listRoles();
    await sendReply(
      api,
      event,
      roles.length > 0 ? ["User roles:", ...roles.map(formatRoleRecord)].join("\n") : "No roles configured.",
    );
    return;
  }
  if (sub === "grant") {
    if (!(await requireOwner(params, "grant user roles"))) {
      return;
    }
    const userId = normalizeSingleArg(args[1]);
    const role = parseTelegramUserRole(args[2]);
    if (!userId || !role || role === "user") {
      await sendReply(api, event, "Usage: /users grant <user-id> <owner|admin|trusted> [reason]");
      return;
    }
    try {
      const granted = governance.setUserRole({
        userId,
        role,
        actorUserId: event.fromUserId,
        reason: normalizeFreeText(args.slice(3)) || undefined,
      });
      await sendReply(api, event, granted ? `Granted ${granted.role} to ${granted.userId}.` : `Revoked ${userId}.`);
    } catch (error) {
      await sendReply(api, event, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (sub === "revoke") {
    if (!(await requireOwner(params, "revoke user roles"))) {
      return;
    }
    const userId = normalizeSingleArg(args[1]);
    if (!userId) {
      await sendReply(api, event, "Usage: /users revoke <user-id> [reason]");
      return;
    }
    try {
      const revoked = governance.revokeUserRole({
        userId,
        actorUserId: event.fromUserId,
        reason: normalizeFreeText(args.slice(2)) || undefined,
      });
      await sendReply(api, event, revoked ? `Revoked role for ${userId}.` : `No database role found for ${userId}.`);
    } catch (error) {
      await sendReply(api, event, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (sub === "audit") {
    if (!(await requireAdmin(params, "inspect user governance audit records"))) {
      return;
    }
    const limit = parseBoundedLimit(args[1], 10);
    const records = governance.listAudit(limit);
    await sendReply(
      api,
      event,
      records.length > 0
        ? ["User governance audit:", ...records.map(formatGovernanceAuditRecord)].join("\n")
        : "No governance audit records.",
    );
    return;
  }
  if (sub === "chat") {
    await handleUsersChatCommand({ ...params, args: args.slice(1) });
    return;
  }
  await sendReply(api, event, formatUsersHelp(params));
}
