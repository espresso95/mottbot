/** Default macOS launchd label used by the primary Mottbot service. */
export const DEFAULT_SERVICE_LABEL = "ai.mottbot.bot";

/** Conservative launchd label pattern used for service and smoke lane isolation. */
export const SERVICE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validates and normalizes a launchd service label. */
export function normalizeServiceLabel(label: string | undefined): string {
  const normalized = label?.trim() || DEFAULT_SERVICE_LABEL;
  if (!SERVICE_LABEL_PATTERN.test(normalized)) {
    throw new Error("Service label must contain only letters, numbers, dots, underscores, and hyphens.");
  }
  return normalized;
}
