import type { AppConfig } from "../app/config.js";
import { buildSessionKey } from "../sessions/session-key.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { SessionRoute } from "../sessions/types.js";
import type { InboundEvent } from "./types.js";

function matchesBinding(
  binding: AppConfig["agents"]["bindings"][number],
  event: InboundEvent,
): boolean {
  return (
    (binding.chatId === undefined || binding.chatId === event.chatId) &&
    (binding.threadId === undefined || binding.threadId === event.threadId) &&
    (binding.chatType === undefined || binding.chatType === event.chatType) &&
    (binding.userId === undefined || binding.userId === event.fromUserId)
  );
}

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

    const binding = this.config.agents.bindings.find((candidate) => matchesBinding(candidate, event));
    const agentId = binding?.agentId ?? this.config.agents.defaultId;
    const agent =
      this.config.agents.list.find((candidate) => candidate.id === agentId) ??
      this.config.agents.list.find((candidate) => candidate.id === this.config.agents.defaultId);
    if (!agent) {
      throw new Error(`No configured agent found for '${agentId}'.`);
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
      agentId: agent.id,
      profileId: agent.profileId,
      modelRef: agent.modelRef,
      fastMode: agent.fastMode,
      systemPrompt: agent.systemPrompt,
    });
  }
}
