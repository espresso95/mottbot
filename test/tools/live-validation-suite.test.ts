import { describe, expect, it, vi } from "vitest";
import {
  createLiveValidationSuiteResult,
  type ScenarioResult,
} from "../../src/tools/live-validation-suite.js";
import { buildLiveValidationPlan, type LiveValidationScenario } from "../../src/tools/live-validation-suite-helpers.js";

describe("live validation suite runner", () => {
  it("returns a dry-run plan from argv without guard variables", async () => {
    const result = await createLiveValidationSuiteResult({
      plan: buildLiveValidationPlan({}),
      argv: ["--dry-run"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      status: "dry-run",
      scenarios: [{ kind: "preflight", script: "smoke:preflight", envKeys: [] }],
    });
  });

  it("returns blocked when required user credentials are missing", async () => {
    const result = await createLiveValidationSuiteResult({
      plan: buildLiveValidationPlan({
        MOTTBOT_LIVE_VALIDATION_REQUIRE_USER_SMOKE: "true",
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      status: "blocked",
      issues: ["TELEGRAM_API_ID and TELEGRAM_API_HASH are required for user-account smoke scenarios."],
    });
  });

  it("returns a dry-run plan without secret values", async () => {
    const result = await createLiveValidationSuiteResult({
      plan: buildLiveValidationPlan({
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "secret-hash",
        MOTTBOT_LIVE_VALIDATION_DRY_RUN: "true",
        MOTTBOT_LIVE_VALIDATION_SCENARIOS: "usage",
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report).toEqual({
      status: "dry-run",
      skipped: ["preflight excluded by MOTTBOT_LIVE_VALIDATION_SCENARIOS."],
      scenarios: [
        {
          kind: "usage",
          name: "Private /usage command",
          script: "smoke:telegram-user",
          envKeys: [
            "MOTTBOT_LIVE_BOT_USERNAME",
            "MOTTBOT_USER_SMOKE_MESSAGE",
            "MOTTBOT_USER_SMOKE_TARGET",
            "MOTTBOT_USER_SMOKE_WAIT_FOR_REPLY",
            "TELEGRAM_API_HASH",
            "TELEGRAM_API_ID",
          ],
        },
      ],
    });
    expect(JSON.stringify(result.report)).not.toContain("secret-hash");
  });

  it("runs scenarios sequentially and reports success", async () => {
    const run = vi.fn(async (item: LiveValidationScenario): Promise<ScenarioResult> => ({
      kind: item.kind,
      name: item.name,
      script: item.script,
      status: "passed",
      exitCode: 0,
      output: { status: "passed" },
    }));
    const plan = buildLiveValidationPlan({
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      MOTTBOT_LIVE_VALIDATION_SCENARIOS: "health,usage",
    });

    const result = await createLiveValidationSuiteResult({ plan, run });

    expect(result.exitCode).toBe(0);
    expect(run.mock.calls.map(([item]) => item.kind)).toEqual(["health", "usage"]);
    expect(result.report).toMatchObject({
      status: "passed",
      scenarios: [
        { kind: "health", status: "passed" },
        { kind: "usage", status: "passed" },
      ],
    });
  });

  it("returns a failed status when any scenario fails", async () => {
    const run = vi.fn(async (item: LiveValidationScenario): Promise<ScenarioResult> => ({
      kind: item.kind,
      name: item.name,
      script: item.script,
      status: item.kind === "usage" ? "failed" : "passed",
      exitCode: item.kind === "usage" ? 1 : 0,
      output: { status: item.kind === "usage" ? "timeout" : "passed" },
    }));
    const plan = buildLiveValidationPlan({
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      MOTTBOT_LIVE_VALIDATION_SCENARIOS: "health,usage",
    });

    const result = await createLiveValidationSuiteResult({ plan, run });

    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      status: "failed",
      scenarios: [
        { kind: "health", status: "passed" },
        { kind: "usage", status: "failed" },
      ],
    });
  });
});
