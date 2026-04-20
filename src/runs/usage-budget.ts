import type { AppConfig } from "../app/config.js";
import type { Clock } from "../shared/clock.js";
import type { SessionRoute } from "../sessions/types.js";
import type { RunStore, UsageBudgetRunCountScope } from "./run-store.js";

type BudgetWindow = "daily" | "monthly";
type BudgetScope = "global" | "user" | "chat" | "session" | "model";

export type UsageBudgetDecision = {
  allowed: boolean;
  deniedReason?: string;
  warnings: string[];
};

export class UsageBudgetExceededError extends Error {
  readonly code = "usage_budget_denied";

  constructor(message: string) {
    super(message);
    this.name = "UsageBudgetExceededError";
  }
}

type BudgetRule = {
  key: keyof AppConfig["usage"];
  window: BudgetWindow;
  scope: BudgetScope;
  label: string;
  limit: number;
  countScope: UsageBudgetRunCountScope;
};

function startOfUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function formatLimit(rule: BudgetRule, count: number): string {
  return `${rule.label} run budget is ${count}/${rule.limit}.`;
}

export class UsageBudgetService {
  constructor(
    private readonly config: AppConfig,
    private readonly runs: RunStore,
    private readonly clock: Clock,
  ) {}

  evaluate(params: { session: SessionRoute; modelRef: string; currentRunId?: string }): UsageBudgetDecision {
    const rules = this.rules(params);
    const warnings: string[] = [];
    for (const rule of rules) {
      if (rule.limit < 1) {
        continue;
      }
      const count = this.runs.countUsageBudgetRuns(rule.countScope);
      if (count >= rule.limit) {
        return {
          allowed: false,
          deniedReason: `${formatLimit(rule, count)} Try again after the ${rule.window} UTC window resets or ask an owner/admin to raise the limit.`,
          warnings,
        };
      }
      const warningAt = Math.max(1, Math.ceil(rule.limit * (this.config.usage.warningThresholdPercent / 100)));
      if (count + 1 >= warningAt) {
        warnings.push(`${formatLimit(rule, count + 1)} Approaching the ${rule.window} UTC limit.`);
      }
    }
    return { allowed: true, warnings };
  }

  formatUsageReport(params: { session: SessionRoute; window: BudgetWindow }): string {
    const now = this.clock.now();
    const since = params.window === "daily" ? startOfUtcDay(now) : startOfUtcMonth(now);
    const label = params.window === "daily" ? "Daily" : "Monthly";
    const lines = [
      `${label} usage since ${new Date(since).toISOString()}:`,
      `- global runs: ${this.runs.countUsageBudgetRuns({ since })}`,
      `- this chat: ${this.runs.countUsageBudgetRuns({ since, chatId: params.session.chatId })}`,
      `- this session: ${this.runs.countUsageBudgetRuns({ since, sessionKey: params.session.sessionKey })}`,
      ...(params.session.userId
        ? [`- this user: ${this.runs.countUsageBudgetRuns({ since, userId: params.session.userId })}`]
        : []),
      `- current model (${params.session.modelRef}): ${this.runs.countUsageBudgetRuns({
        since,
        modelRef: params.session.modelRef,
      })}`,
    ];
    const models = this.runs.countUsageBudgetRunsByModel({ since, limit: 5 });
    if (models.length > 0) {
      lines.push("Top models:", ...models.map((model) => `- ${model.modelRef}: ${model.runs}`));
    }
    const configured = this.configuredLimits(params.window);
    lines.push(
      configured.length > 0
        ? `Configured ${params.window} limits: ${configured.join(", ")}`
        : `No ${params.window} limits configured.`,
    );
    return lines.join("\n");
  }

  private configuredLimits(window: BudgetWindow): string[] {
    return this.ruleSpecs(window)
      .map((spec) => {
        const limit = this.config.usage[spec.key];
        return typeof limit === "number" && limit > 0 ? `${spec.label}=${limit}` : undefined;
      })
      .filter((value): value is string => Boolean(value));
  }

  private rules(params: { session: SessionRoute; modelRef: string; currentRunId?: string }): BudgetRule[] {
    const daily = startOfUtcDay(this.clock.now());
    const monthly = startOfUtcMonth(this.clock.now());
    return [
      ...this.buildRules("daily", daily, params),
      ...this.buildRules("monthly", monthly, params),
    ];
  }

  private buildRules(
    window: BudgetWindow,
    since: number,
    params: { session: SessionRoute; modelRef: string; currentRunId?: string },
  ): BudgetRule[] {
    return this.ruleSpecs(window).flatMap((spec): BudgetRule[] => {
      const countScope = this.countScope({
        scope: spec.scope,
        since,
        session: params.session,
        modelRef: params.modelRef,
        currentRunId: params.currentRunId,
      });
      if (!countScope) {
        return [];
      }
      const limit = this.config.usage[spec.key];
      return [
        {
          ...spec,
          limit: typeof limit === "number" ? limit : 0,
          countScope,
        },
      ];
    });
  }

  private ruleSpecs(window: BudgetWindow): Array<{
    key: keyof AppConfig["usage"];
    window: BudgetWindow;
    scope: BudgetScope;
    label: string;
  }> {
    return window === "daily"
      ? [
          { key: "dailyRuns", window, scope: "global", label: "daily global" },
          { key: "dailyRunsPerUser", window, scope: "user", label: "daily user" },
          { key: "dailyRunsPerChat", window, scope: "chat", label: "daily chat" },
          { key: "dailyRunsPerSession", window, scope: "session", label: "daily session" },
          { key: "dailyRunsPerModel", window, scope: "model", label: "daily model" },
        ]
      : [
          { key: "monthlyRuns", window, scope: "global", label: "monthly global" },
          { key: "monthlyRunsPerUser", window, scope: "user", label: "monthly user" },
          { key: "monthlyRunsPerChat", window, scope: "chat", label: "monthly chat" },
          { key: "monthlyRunsPerSession", window, scope: "session", label: "monthly session" },
          { key: "monthlyRunsPerModel", window, scope: "model", label: "monthly model" },
        ];
  }

  private countScope(params: {
    scope: BudgetScope;
    since: number;
    session: SessionRoute;
    modelRef: string;
    currentRunId?: string;
  }): UsageBudgetRunCountScope | undefined {
    const base = {
      since: params.since,
      ...(params.currentRunId ? { excludeRunId: params.currentRunId } : {}),
    };
    switch (params.scope) {
      case "global":
        return base;
      case "user":
        return params.session.userId ? { ...base, userId: params.session.userId } : undefined;
      case "chat":
        return { ...base, chatId: params.session.chatId };
      case "session":
        return { ...base, sessionKey: params.session.sessionKey };
      case "model":
        return { ...base, modelRef: params.modelRef };
    }
  }
}
