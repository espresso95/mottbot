import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCodexUsage } from "../../src/codex/usage.js";

describe("fetchCodexUsage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps windows and plan metadata", async () => {
    const fetchMock = vi.fn(async (_url: string, options: any) => ({
      ok: true,
      json: async () => ({
        rate_limit: {
          primary_window: { limit_window_seconds: 10800, used_percent: 15, reset_at: 100 },
          secondary_window: { limit_window_seconds: 86400, used_percent: 80, reset_at: 200 },
        },
        plan_type: "pro",
        credits: { balance: 12.5 },
      }),
      headers: options?.headers,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await fetchCodexUsage({ accessToken: "token", accountId: "acct" });
    expect(snapshot.plan).toBe("pro ($12.50)");
    expect(snapshot.windows).toEqual([
      { label: "3h", usedPercent: 15, resetAt: 100_000 },
      { label: "Day", usedPercent: 80, resetAt: 200_000 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "ChatGPT-Account-Id": "acct",
        }),
      }),
    );
  });

  it("throws on failed responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
      })),
    );
    await expect(fetchCodexUsage({ accessToken: "token" })).rejects.toThrow("401");
  });

  it("aborts usage requests after the configured timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, options: RequestInit) =>
          await new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    await expect(fetchCodexUsage({ accessToken: "token", timeoutMs: 1 })).rejects.toThrow("aborted");
  });

  it("normalizes sparse or odd usage payloads safely", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          rate_limit: {
            primary_window: { limit_window_seconds: 7200, used_percent: 123 },
          },
          credits: { balance: "bad-number" },
        }),
      })),
    );

    const snapshot = await fetchCodexUsage({ accessToken: "token" });

    expect(snapshot.plan).toBe("$0.00");
    expect(snapshot.windows).toEqual([{ label: "2h", usedPercent: 100 }]);
  });
});
