import type { AppConfig } from "../app/config.js";
import type { TelegramMessageStore } from "./message-store.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { InboundEvent } from "./types.js";
import type { TelegramGovernanceStore } from "./governance.js";
import { isGovernanceOperatorRole } from "./governance.js";

/** Decision returned after checking whether an inbound Telegram event should be processed. */
export type AccessDecision =
  | { allow: true; reason: "private" | "mentioned" | "reply" | "bound" | "command" }
  | { allow: false; reason: string };

/** Applies chat allow-lists, governance roles, mentions, replies, and bound-route access rules. */
export class AccessController {
  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
    private readonly messages: TelegramMessageStore,
    private readonly governance?: TelegramGovernanceStore,
  ) {}

  evaluate(event: InboundEvent): AccessDecision {
    const role =
      this.governance?.resolveUserRole(event.fromUserId) ??
      (event.fromUserId && this.config.telegram.adminUserIds.includes(event.fromUserId) ? "owner" : "user");
    if (isGovernanceOperatorRole(role)) {
      return { allow: true, reason: event.isCommand ? "command" : "private" };
    }

    if (this.config.telegram.allowedChatIds.length > 0 && !this.config.telegram.allowedChatIds.includes(event.chatId)) {
      return { allow: false, reason: "chat_not_allowed" };
    }

    if (this.governance && !this.governance.isChatAllowed({ chatId: event.chatId, userId: event.fromUserId })) {
      return { allow: false, reason: "role_not_allowed" };
    }

    if (event.chatType === "private") {
      return { allow: true, reason: "private" };
    }

    if (event.isCommand) {
      return { allow: true, reason: "command" };
    }

    const existingRoute = this.sessions.findByChat(event.chatId, event.threadId);
    if (existingRoute?.routeMode === "bound") {
      return { allow: true, reason: "bound" };
    }

    if (
      typeof event.replyToMessageId === "number" &&
      this.messages.hasMessage({
        chatId: event.chatId,
        threadId: event.threadId,
        telegramMessageId: event.replyToMessageId,
      })
    ) {
      return { allow: true, reason: "reply" };
    }

    if (this.config.behavior.respondInGroupsOnlyWhenMentioned) {
      return event.mentionsBot ? { allow: true, reason: "mentioned" } : { allow: false, reason: "mention_required" };
    }

    return { allow: true, reason: "mentioned" };
  }
}
