export const RUN_STATUS_TEXT = {
  starting: "Starting run...",
  resumingAfterRestart: "Resuming queued run after restart...",
  unableToResumeAfterRestart: "Unable to resume queued run after restart.",
} as const;

const LEGACY_TRANSIENT_RUN_STATUS_TEXTS = new Set<string>([
  "Working...",
  "Resuming queued request after restart...",
  "Unable to resume queued request after restart.",
]);

const CURRENT_TRANSIENT_RUN_STATUS_TEXTS = new Set<string>(Object.values(RUN_STATUS_TEXT));

export function formatToolPreparingStatus(toolName: string): string {
  return `Preparing tool: ${toolName}...`;
}

export function formatToolRunningStatus(toolName: string): string {
  return `Running tool: ${toolName}...`;
}

export function formatToolCompletedStatus(params: { toolName: string; isError: boolean }): string {
  return `Tool ${params.toolName} ${params.isError ? "failed" : "completed"}. Continuing...`;
}

export function formatRunFailedStatus(message: string): string {
  return `Run failed: ${message}`;
}

export function isTransientRunStatus(text: string): boolean {
  const trimmed = text.trim();
  return (
    CURRENT_TRANSIENT_RUN_STATUS_TEXTS.has(trimmed) ||
    LEGACY_TRANSIENT_RUN_STATUS_TEXTS.has(trimmed) ||
    /^Preparing tool: .+\.\.\.$/.test(trimmed) ||
    /^Running tool: .+\.\.\.$/.test(trimmed) ||
    /^Tool .+ (completed|failed)\. Continuing\.\.\.$/.test(trimmed)
  );
}
