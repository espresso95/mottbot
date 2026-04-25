import type { Api } from "grammy";
import type { AppConfig } from "../app/config.js";
import type { AuthProfileStore } from "../codex/auth-store.js";
import { importCodexCliAuthProfile } from "../codex/cli-auth-import.js";
import { sendReply } from "./command-replies.js";
import type { InboundEvent } from "./types.js";

/** Dependencies needed by the Telegram auth command handler. */
type AuthCommandDependencies = {
  api: Api;
  event: InboundEvent;
  args: string[];
  config: AppConfig;
  authProfiles: AuthProfileStore;
};

/** Handles /auth status, /auth import-cli, and /auth login. */
export async function handleAuthCommand(params: AuthCommandDependencies): Promise<void> {
  const { api, event, args, config, authProfiles } = params;
  const sub = args[0]?.toLowerCase();
  if (sub === "status") {
    const profiles = authProfiles.list();
    await sendReply(
      api,
      event,
      profiles.length > 0
        ? profiles
            .map((profile) => `${profile.profileId}: ${profile.source}${profile.email ? ` (${profile.email})` : ""}`)
            .join("\n")
        : "No auth profiles configured.",
    );
    return;
  }
  if (sub === "import-cli") {
    const result = importCodexCliAuthProfile({
      store: authProfiles,
      profileId: config.auth.defaultProfile,
    });
    await sendReply(
      api,
      event,
      result.imported
        ? `Imported Codex CLI credentials into ${result.profileId}.`
        : "No Codex CLI ChatGPT auth.json was found.",
    );
    return;
  }
  if (sub === "login") {
    await sendReply(api, event, "Run `pnpm auth:login` on the host machine to complete local OAuth login.");
    return;
  }
  await sendReply(api, event, "Usage: /auth status | /auth import-cli | /auth login");
}
