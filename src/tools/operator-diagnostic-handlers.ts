import type { OperatorDiagnostics } from "../app/diagnostics.js";
import type { ToolHandler } from "./executor.js";

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Creates operator diagnostic tool handlers backed by runtime diagnostics services. */
export function createOperatorDiagnosticToolHandlers(
  diagnostics: OperatorDiagnostics,
): Partial<Record<string, ToolHandler>> {
  return {
    mottbot_service_status: () => diagnostics.serviceStatus(),
    mottbot_recent_runs: ({ arguments: input }) =>
      diagnostics.recentRuns({
        limit: optionalInteger(input.limit),
        sessionKey: optionalString(input.sessionKey),
      }),
    mottbot_recent_errors: ({ arguments: input }) => diagnostics.recentErrorsText(optionalInteger(input.limit)),
    mottbot_recent_logs: ({ arguments: input }) =>
      diagnostics.recentLogsText({
        stream:
          input.stream === "stdout" || input.stream === "stderr" || input.stream === "both" ? input.stream : undefined,
        lines: optionalInteger(input.lines),
      }),
  };
}
