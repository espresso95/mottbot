import type { Api } from "grammy";
import type { HealthReporter } from "../app/health.js";
import type { OperatorDiagnostics } from "../app/diagnostics.js";
import type { SessionRoute } from "../sessions/types.js";
import { sendReply } from "./command-replies.js";
import type { InboundEvent } from "./types.js";

/** Dependencies needed by the Telegram run diagnostics command handler. */
type RunsCommandDependencies = {
  api: Api;
  event: InboundEvent;
  session: SessionRoute;
  args: string[];
  diagnostics?: OperatorDiagnostics;
  isAdmin: boolean;
};

/** Dependencies needed by the Telegram debug diagnostics command handler. */
type DebugCommandDependencies = RunsCommandDependencies & {
  health: HealthReporter;
};

/** Handles /runs recent-run diagnostics. */
export async function handleRunsCommand(params: RunsCommandDependencies): Promise<void> {
  const { api, event, session, args, diagnostics, isAdmin } = params;
  if (!isAdmin) {
    await sendReply(api, event, "Only owner/admin roles can inspect runs.");
    return;
  }
  if (!diagnostics) {
    await sendReply(api, event, "Diagnostics are not available.");
    return;
  }
  const limit = Number(args[0] ?? 10);
  await sendReply(
    api,
    event,
    diagnostics.recentRunsText({
      limit: Number.isInteger(limit) ? limit : 10,
      sessionKey: args.includes("here") ? session.sessionKey : undefined,
    }),
  );
}

/** Handles /debug runtime diagnostics subcommands. */
export async function handleDebugCommand(params: DebugCommandDependencies): Promise<void> {
  const { api, event, session, args, diagnostics, health, isAdmin } = params;
  if (!isAdmin) {
    await sendReply(api, event, "Only owner/admin roles can inspect diagnostics.");
    return;
  }
  if (!diagnostics) {
    await sendReply(api, event, "Diagnostics are not available.");
    return;
  }
  const sub = args[0]?.toLowerCase() ?? "summary";
  if (sub === "summary") {
    await sendReply(
      api,
      event,
      [
        health.formatForText(),
        "",
        diagnostics.configText(),
        "",
        diagnostics.recentRunsText({ limit: 5, sessionKey: session.sessionKey }),
      ].join("\n"),
    );
    return;
  }
  if (sub === "service") {
    await sendReply(api, event, diagnostics.serviceStatus());
    return;
  }
  if (sub === "runs") {
    const limit = Number(args[1] ?? 10);
    await sendReply(
      api,
      event,
      diagnostics.recentRunsText({
        limit: Number.isInteger(limit) ? limit : 10,
        sessionKey: args.includes("here") ? session.sessionKey : undefined,
      }),
    );
    return;
  }
  if (sub === "agents") {
    await sendReply(api, event, diagnostics.agentDiagnosticsText());
    return;
  }
  if (sub === "errors") {
    const limit = Number(args[1] ?? 10);
    await sendReply(api, event, diagnostics.recentErrorsText(Number.isInteger(limit) ? limit : 10));
    return;
  }
  if (sub === "logs") {
    const stream = args[1] === "stdout" || args[1] === "stderr" || args[1] === "both" ? args[1] : "both";
    const rawLines = Number(stream === args[1] ? (args[2] ?? 40) : (args[1] ?? 40));
    await sendReply(
      api,
      event,
      diagnostics.recentLogsText({
        stream,
        lines: Number.isInteger(rawLines) ? rawLines : 40,
      }),
    );
    return;
  }
  if (sub === "config") {
    await sendReply(api, event, diagnostics.configText());
    return;
  }
  await sendReply(
    api,
    event,
    "Usage: /debug [summary|service|runs [limit] [here]|agents|errors [limit]|logs [stdout|stderr|both] [lines]|config]",
  );
}
