import type { AgentConfig, AppConfig } from "../app/config.js";
import { buildSessionKey } from "../sessions/session-key.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { SessionRoute } from "../sessions/types.js";
import type { InboundEvent } from "./types.js";

function matchesBinding(binding: AppConfig["agents"]["bindings"][number], event: InboundEvent): boolean {
  return (
    (binding.chatId === undefined || binding.chatId === event.chatId) &&
    (binding.threadId === undefined || binding.threadId === event.threadId) &&
    (binding.chatType === undefined || binding.chatType === event.chatType) &&
    (binding.userId === undefined || binding.userId === event.fromUserId)
  );
}

function attachProjectKey(session: SessionRoute, projectKey: string | undefined): SessionRoute {
  return projectKey ? { ...session, projectKey } : session;
}

/** Resolves inbound Telegram events to a configured agent and persisted session route. */
export class RouteResolver {
  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {}

  private selectBinding(event: InboundEvent): AppConfig["agents"]["bindings"][number] | undefined {
    return this.config.agents.bindings.find((candidate) => matchesBinding(candidate, event));
  }

  selectAgent(event: InboundEvent): AgentConfig {
    const binding = this.selectBinding(event);
    const agentId = binding?.agentId ?? this.config.agents.defaultId;
    const agent =
      this.config.agents.list.find((candidate) => candidate.id === agentId) ??
      this.config.agents.list.find((candidate) => candidate.id === this.config.agents.defaultId);
    if (!agent) {
      throw new Error(`No configured agent found for '${agentId}'.`);
    }
    return agent;
  }

  resolve(event: InboundEvent): SessionRoute {
    const binding = this.selectBinding(event);
    const existing = this.sessions.findByChat(event.chatId, event.threadId);
    if (existing?.routeMode === "bound") {
      return attachProjectKey(existing, binding?.projectKey);
    }

    const agent = this.selectAgent(event);

    const built = buildSessionKey({
      chatType: event.chatType,
      chatId: event.chatId,
      threadId: event.threadId,
      userId: event.chatType === "private" ? event.fromUserId : undefined,
    });

    const session = this.sessions.ensure({
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
    return attachProjectKey(session, binding?.projectKey);
  }
}
