import type { Api } from "grammy";
import type { AgentConfig, AppConfig } from "../app/config.js";
import type { AuthProfileStore } from "../codex/auth-store.js";
import { isCodexModelRef } from "../codex/provider.js";
import type { UsageBudgetService } from "../runs/usage-budget.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { SessionRoute } from "../sessions/types.js";
import { formatAgentDetails, formatAgentLine } from "./command-formatters.js";
import { normalizeSingleArg } from "./command-parsing.js";
import { sendReply } from "./command-replies.js";
import type { TelegramGovernanceStore } from "./governance.js";
import type { RouteResolver } from "./route-resolver.js";
import type { InboundEvent } from "./types.js";

/** Dependencies needed by the Telegram agent selection command handler. */
export type AgentCommandDependencies = {
  api: Api;
  event: InboundEvent;
  session: SessionRoute;
  args: string[];
  config: AppConfig;
  authProfiles: AuthProfileStore;
  sessions: SessionStore;
  routes: RouteResolver;
  usageBudget?: UsageBudgetService;
  governance?: TelegramGovernanceStore;
  isAdmin: boolean;
};

function findAgent(config: AppConfig, agentId: string): AgentConfig | undefined {
  return config.agents.list.find((agent) => agent.id === agentId);
}

function sessionWithAgent(session: SessionRoute, agent: AgentConfig): SessionRoute {
  return {
    ...session,
    agentId: agent.id,
    profileId: agent.profileId,
    modelRef: agent.modelRef,
    fastMode: agent.fastMode,
    systemPrompt: agent.systemPrompt,
  };
}

function validateAgentSelection(
  params: AgentCommandDependencies,
  agent: AgentConfig,
): { allowed: true; warnings: string[] } | { allowed: false; message: string } {
  const { authProfiles, event, governance, session, usageBudget } = params;
  if (!isCodexModelRef(agent.modelRef)) {
    return { allowed: false, message: `Invalid agent model ${agent.modelRef}. Expected openai-codex/<model>.` };
  }
  if (!authProfiles.get(agent.profileId)) {
    return { allowed: false, message: `Agent profile ${agent.profileId} is not configured.` };
  }
  if (governance && !governance.isModelAllowed({ chatId: event.chatId, modelRef: agent.modelRef })) {
    return { allowed: false, message: `Agent model ${agent.modelRef} is not allowed in this chat.` };
  }
  const budgetDecision = usageBudget?.evaluate({
    session: sessionWithAgent(session, agent),
    modelRef: agent.modelRef,
  });
  if (budgetDecision && !budgetDecision.allowed) {
    return {
      allowed: false,
      message: budgetDecision.deniedReason ?? `Agent model ${agent.modelRef} exceeds a usage budget.`,
    };
  }
  return {
    allowed: true,
    warnings: budgetDecision?.warnings ?? [],
  };
}

async function applyAgentSelection(params: AgentCommandDependencies, agent: AgentConfig, label: string): Promise<void> {
  const { api, event, session, sessions } = params;
  const decision = validateAgentSelection(params, agent);
  if (!decision.allowed) {
    await sendReply(api, event, decision.message);
    return;
  }
  sessions.setAgent(session.sessionKey, agent);
  await sendReply(
    api,
    event,
    [
      `${label} to ${agent.id}.`,
      `Model: ${agent.modelRef}`,
      `Profile: ${agent.profileId}`,
      `Fast mode: ${agent.fastMode ? "on" : "off"}`,
      ...decision.warnings,
    ].join("\n"),
  );
}

async function requireAgentAdmin(params: AgentCommandDependencies, action: string): Promise<boolean> {
  if (params.isAdmin) {
    return true;
  }
  await sendReply(params.api, params.event, `Only owner/admin roles can ${action}.`);
  return false;
}

/** Handles /agent list, show, set, and reset subcommands for the current session route. */
export async function handleAgentCommand(params: AgentCommandDependencies): Promise<void> {
  const { api, config, event, routes, session, args } = params;
  const sub = args[0]?.toLowerCase() ?? "show";
  if (sub === "list") {
    await sendReply(
      api,
      event,
      [
        "Configured agents:",
        ...config.agents.list.map((agent) =>
          formatAgentLine(agent, { currentId: session.agentId, defaultId: config.agents.defaultId }),
        ),
      ].join("\n"),
    );
    return;
  }
  if (sub === "show") {
    const requestedAgentId = normalizeSingleArg(args[1]);
    const agent = requestedAgentId ? findAgent(config, requestedAgentId) : findAgent(config, session.agentId);
    if (!agent) {
      await sendReply(
        api,
        event,
        requestedAgentId
          ? `Unknown agent ${requestedAgentId}.`
          : `Current route agent ${session.agentId} is not in the current config.`,
      );
      return;
    }
    await sendReply(api, event, formatAgentDetails(agent));
    return;
  }
  if (sub === "set") {
    if (!(await requireAgentAdmin(params, "change session agents"))) {
      return;
    }
    const agentId = normalizeSingleArg(args[1]);
    const agent = agentId ? findAgent(config, agentId) : undefined;
    if (!agent) {
      await sendReply(api, event, "Usage: /agent set <agent-id>");
      return;
    }
    await applyAgentSelection(params, agent, "Agent set");
    return;
  }
  if (sub === "reset") {
    if (!(await requireAgentAdmin(params, "reset session agents"))) {
      return;
    }
    await applyAgentSelection(params, routes.selectAgent(event), "Agent reset");
    return;
  }
  await sendReply(api, event, "Usage: /agent [list|show [agent-id]|set <agent-id>|reset]");
}
