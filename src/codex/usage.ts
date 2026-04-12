import type { CodexUsageSnapshot, CodexUsageWindow } from "./types.js";

type CodexUsageResponse = {
  rate_limit?: {
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildWindow(label: string, usedPercent?: number, resetAt?: number): CodexUsageWindow {
  return {
    label,
    usedPercent: clampPercent(usedPercent ?? 0),
    ...(typeof resetAt === "number" ? { resetAt: resetAt * 1000 } : {}),
  };
}

export async function fetchCodexUsage(params: {
  accessToken: string;
  accountId?: string;
  timeoutMs?: number;
}): Promise<CodexUsageSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 10_000);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${params.accessToken}`,
      Accept: "application/json",
      "User-Agent": "Mottbot",
    };
    if (params.accountId) {
      headers["ChatGPT-Account-Id"] = params.accountId;
    }
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Usage request failed with ${response.status}.`);
    }
    const data = (await response.json()) as CodexUsageResponse;
    const windows: CodexUsageWindow[] = [];
    if (data.rate_limit?.primary_window) {
      const limitHours = Math.round((data.rate_limit.primary_window.limit_window_seconds ?? 10_800) / 3600);
      windows.push(
        buildWindow(
          `${limitHours}h`,
          data.rate_limit.primary_window.used_percent,
          data.rate_limit.primary_window.reset_at,
        ),
      );
    }
    if (data.rate_limit?.secondary_window) {
      const limitHours = Math.round((data.rate_limit.secondary_window.limit_window_seconds ?? 86_400) / 3600);
      windows.push(
        buildWindow(
          limitHours >= 168 ? "Week" : limitHours >= 24 ? "Day" : `${limitHours}h`,
          data.rate_limit.secondary_window.used_percent,
          data.rate_limit.secondary_window.reset_at,
        ),
      );
    }
    let plan = data.plan_type;
    if (data.credits?.balance !== undefined && data.credits.balance !== null) {
      const balance =
        typeof data.credits.balance === "number"
          ? data.credits.balance
          : Number.parseFloat(String(data.credits.balance)) || 0;
      plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
    }
    return {
      provider: "openai-codex",
      displayName: "OpenAI Codex",
      windows,
      ...(plan ? { plan } : {}),
    };
  } finally {
    clearTimeout(timeout);
  }
}
