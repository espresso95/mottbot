import type { AppConfig } from "../app/config.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { InboundEvent } from "./types.js";

export type AccessDecision =
  | { allow: true; reason: "private" | "mentioned" | "reply" | "bound" | "command" }
  | { allow: false; reason: string };

export class AccessController {
  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {}

  evaluate(event: InboundEvent): AccessDecision {
    if (event.fromUserId && this.config.telegram.adminUserIds.includes(event.fromUserId)) {
      return { allow: true, reason: event.isCommand ? "command" : "private" };
    }

    if (
      this.config.telegram.allowedChatIds.length > 0 &&
      !this.config.telegram.allowedChatIds.includes(event.chatId)
    ) {
      return { allow: false, reason: "chat_not_allowed" };
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

    if (event.replyToMessageId) {
      return { allow: true, reason: "reply" };
    }

    if (this.config.behavior.respondInGroupsOnlyWhenMentioned) {
      return event.mentionsBot
        ? { allow: true, reason: "mentioned" }
        : { allow: false, reason: "mention_required" };
    }

    return { allow: true, reason: "mentioned" };
  }
}
