import type { AppConfig } from "../app/config.js";
import { buildSessionKey } from "../sessions/session-key.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { SessionRoute } from "../sessions/types.js";
import type { InboundEvent } from "./types.js";

export class RouteResolver {
  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {}

  resolve(event: InboundEvent): SessionRoute {
    const existing = this.sessions.findByChat(event.chatId, event.threadId);
    if (existing?.routeMode === "bound") {
      return existing;
    }

    const built = buildSessionKey({
      chatType: event.chatType,
      chatId: event.chatId,
      threadId: event.threadId,
      userId: event.chatType === "private" ? event.fromUserId : undefined,
    });

    return this.sessions.ensure({
      sessionKey: built.sessionKey,
      chatId: event.chatId,
      threadId: event.threadId,
      userId: event.fromUserId,
      routeMode: built.routeMode,
      profileId: this.config.auth.defaultProfile,
      modelRef: this.config.models.default,
    });
  }
}
