import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import { importCodexCliAuthProfile } from "../codex/cli-auth-import.js";
import type { AuthProfileStore } from "../codex/auth-store.js";
import type { CodexTokenResolver } from "../codex/token-resolver.js";
import { fetchCodexUsage } from "../codex/usage.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { TranscriptStore } from "../sessions/transcript-store.js";
import type { RunOrchestrator } from "../runs/run-orchestrator.js";
import type { RouteResolver } from "./route-resolver.js";
import { splitTelegramText } from "./formatting.js";
import type { InboundEvent, ParsedCommand } from "./types.js";

function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  const [head = "", ...rest] = trimmed.split(/\s+/);
  const command = head.replace(/^\//, "").replace(/@.+$/, "").toLowerCase();
  return {
    command,
    args: rest,
    raw: trimmed,
  };
}

async function sendReply(
  api: Api,
  event: InboundEvent,
  text: string,
): Promise<void> {
  for (const chunk of splitTelegramText(text)) {
    await api.sendMessage(event.chatId, chunk, {
      ...(typeof event.threadId === "number" ? { message_thread_id: event.threadId } : {}),
      reply_parameters: { message_id: event.messageId },
    });
  }
}

export class TelegramCommandRouter {
  constructor(
    private readonly api: Api,
    private readonly config: AppConfig,
    private readonly routes: RouteResolver,
    private readonly sessions: SessionStore,
    private readonly transcripts: TranscriptStore,
    private readonly authProfiles: AuthProfileStore,
    private readonly tokenResolver: CodexTokenResolver,
    private readonly orchestrator: RunOrchestrator,
  ) {}

  async maybeHandle(event: InboundEvent): Promise<boolean> {
    const raw = event.text ?? event.caption;
    if (!raw?.trim().startsWith("/")) {
      return false;
    }
    const parsed = parseCommand(raw);
    const session = this.routes.resolve(event);

    switch (parsed.command) {
      case "status": {
        const authCount = this.authProfiles.list().length;
        let usageSummary = "Usage unavailable";
        try {
          const auth = await this.tokenResolver.resolve(session.profileId);
          const usage = await fetchCodexUsage({
            accessToken: auth.accessToken,
            accountId: auth.accountId,
          });
          usageSummary = usage.windows.map((window) => `${window.label}: ${window.usedPercent}%`).join(", ");
        } catch {
          // keep fallback summary
        }
        await sendReply(
          this.api,
          event,
          [
            `Session: ${session.sessionKey}`,
            `Model: ${session.modelRef}`,
            `Profile: ${session.profileId}`,
            `Fast mode: ${session.fastMode ? "on" : "off"}`,
            `Auth profiles: ${authCount}`,
            `Usage: ${usageSummary}`,
          ].join("\n"),
        );
        return true;
      }
      case "model": {
        if (!parsed.args[0]) {
          await sendReply(this.api, event, "Usage: /model <provider/model>");
          return true;
        }
        this.sessions.setModelRef(session.sessionKey, parsed.args[0]);
        await sendReply(this.api, event, `Model set to ${parsed.args[0]}.`);
        return true;
      }
      case "profile": {
        if (!parsed.args[0]) {
          const profiles = this.authProfiles.list();
          await sendReply(
            this.api,
            event,
            profiles.length > 0
              ? `Profiles:\n${profiles.map((profile) => `- ${profile.profileId} (${profile.source})`).join("\n")}`
              : "No auth profiles found.",
          );
          return true;
        }
        this.sessions.setProfileId(session.sessionKey, parsed.args[0]);
        await sendReply(this.api, event, `Profile set to ${parsed.args[0]}.`);
        return true;
      }
      case "fast": {
        if (!parsed.args[0] || !["on", "off"].includes(parsed.args[0])) {
          await sendReply(this.api, event, "Usage: /fast on|off");
          return true;
        }
        const next = parsed.args[0] === "on";
        this.sessions.setFastMode(session.sessionKey, next);
        await sendReply(this.api, event, `Fast mode ${next ? "enabled" : "disabled"}.`);
        return true;
      }
      case "new":
      case "reset": {
        this.transcripts.clearSession(session.sessionKey);
        await sendReply(this.api, event, "Session transcript cleared.");
        return true;
      }
      case "stop": {
        const stopped = await this.orchestrator.stop(session.sessionKey);
        await sendReply(this.api, event, stopped ? "Active run cancelled." : "No active run.");
        return true;
      }
      case "bind": {
        this.sessions.bind(session.sessionKey, parsed.args.join(" ") || "here");
        await sendReply(this.api, event, "Route bound for always-on replies in this chat/topic.");
        return true;
      }
      case "unbind": {
        this.sessions.unbind(session.sessionKey);
        await sendReply(this.api, event, "Route unbound.");
        return true;
      }
      case "auth": {
        const sub = parsed.args[0]?.toLowerCase();
        if (sub === "status") {
          const profiles = this.authProfiles.list();
          await sendReply(
            this.api,
            event,
            profiles.length > 0
              ? profiles
                  .map(
                    (profile) =>
                      `${profile.profileId}: ${profile.source}${profile.email ? ` (${profile.email})` : ""}`,
                  )
                  .join("\n")
              : "No auth profiles configured.",
          );
          return true;
        }
        if (sub === "import-cli") {
          const result = importCodexCliAuthProfile({
            store: this.authProfiles,
            profileId: this.config.auth.defaultProfile,
          });
          await sendReply(
            this.api,
            event,
            result.imported
              ? `Imported Codex CLI credentials into ${result.profileId}.`
              : "No Codex CLI ChatGPT auth.json was found.",
          );
          return true;
        }
        if (sub === "login") {
          await sendReply(
            this.api,
            event,
            "Run `pnpm auth:login` on the host machine to complete local OAuth login.",
          );
          return true;
        }
        await sendReply(this.api, event, "Usage: /auth status | /auth import-cli | /auth login");
        return true;
      }
      default:
        return false;
    }
  }
}
