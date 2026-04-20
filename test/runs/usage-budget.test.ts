import { describe, expect, it } from "vitest";
import { UsageBudgetService } from "../../src/runs/usage-budget.js";
import { createStores } from "../helpers/fakes.js";
import { removeTempDir } from "../helpers/tmp.js";

describe("UsageBudgetService", () => {
  it("denies runs when a scoped daily budget is exhausted", () => {
    const stores = createStores({
      usage: {
        dailyRunsPerUser: 1,
      },
    });
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const first = stores.runs.create({
        sessionKey: session.sessionKey,
        modelRef: session.modelRef,
        profileId: session.profileId,
      });
      stores.runs.update(first.runId, { status: "completed", finishedAt: stores.clock.now() });
      const budgets = new UsageBudgetService(stores.config, stores.runs, stores.clock);

      const denied = budgets.evaluate({ session, modelRef: session.modelRef });

      expect(denied.allowed).toBe(false);
      expect(denied.deniedReason).toContain("daily user run budget is 1/1");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("ignores prior budget-denied rows and warns near configured limits", () => {
    const stores = createStores({
      usage: {
        dailyRunsPerSession: 3,
        warningThresholdPercent: 66,
      },
    });
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const failed = stores.runs.create({
        sessionKey: session.sessionKey,
        modelRef: session.modelRef,
        profileId: session.profileId,
      });
      stores.runs.update(failed.runId, {
        status: "failed",
        errorCode: "usage_budget_denied",
        errorMessage: "denied",
        finishedAt: stores.clock.now(),
      });
      for (let index = 0; index < 1; index += 1) {
        const run = stores.runs.create({
          sessionKey: session.sessionKey,
          modelRef: session.modelRef,
          profileId: session.profileId,
        });
        stores.runs.update(run.runId, { status: "completed", finishedAt: stores.clock.now() });
      }
      const budgets = new UsageBudgetService(stores.config, stores.runs, stores.clock);

      const decision = budgets.evaluate({ session, modelRef: session.modelRef });

      expect(decision.allowed).toBe(true);
      expect(decision.warnings).toEqual([
        "daily session run budget is 2/3. Approaching the daily UTC limit.",
      ]);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("formats daily and monthly usage reports", () => {
    const stores = createStores({
      usage: {
        dailyRuns: 10,
        monthlyRunsPerModel: 20,
      },
    });
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      const run = stores.runs.create({
        sessionKey: session.sessionKey,
        modelRef: session.modelRef,
        profileId: session.profileId,
      });
      stores.runs.update(run.runId, { status: "completed", finishedAt: stores.clock.now() });
      const budgets = new UsageBudgetService(stores.config, stores.runs, stores.clock);

      expect(budgets.formatUsageReport({ session, window: "daily" })).toContain("Configured daily limits: daily global=10");
      expect(budgets.formatUsageReport({ session, window: "monthly" })).toContain("monthly model=20");
      expect(budgets.formatUsageReport({ session, window: "monthly" })).toContain("Top models:");
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });

  it("uses UTC day boundaries for daily budgets", () => {
    const stores = createStores({
      usage: {
        dailyRunsPerSession: 1,
      },
    });
    try {
      const session = stores.sessions.ensure({
        sessionKey: "tg:dm:chat-1:user:user-1",
        chatId: "chat-1",
        userId: "user-1",
        routeMode: "dm",
        profileId: "openai-codex:default",
        modelRef: "openai-codex/gpt-5.4",
      });
      stores.clock.advance(Date.UTC(2026, 0, 1, 23, 59) - stores.clock.now());
      const priorDayRun = stores.runs.create({
        sessionKey: session.sessionKey,
        modelRef: session.modelRef,
        profileId: session.profileId,
      });
      stores.runs.update(priorDayRun.runId, { status: "completed", finishedAt: stores.clock.now() });
      stores.clock.advance(Date.UTC(2026, 0, 2, 0, 1) - stores.clock.now());
      const budgets = new UsageBudgetService(stores.config, stores.runs, stores.clock);

      const decision = budgets.evaluate({ session, modelRef: session.modelRef });

      expect(decision.allowed).toBe(true);
      expect(decision.warnings).toEqual(["daily session run budget is 1/1. Approaching the daily UTC limit."]);
    } finally {
      stores.database.close();
      removeTempDir(stores.tempDir);
    }
  });
});
