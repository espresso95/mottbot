import { describe, expect, it, vi } from "vitest";
import {
  buildScenarioCommandArgs,
  createLiveValidationSuiteResult,
  type ScenarioResult,
} from "../../scripts/smoke/live-validation-suite.js";
import {
  buildLiveValidationPlan,
  type LiveValidationScenario,
} from "../../scripts/smoke/live-validation-suite-helpers.js";

describe("live validation suite runner", () => {
  it("forwards scenario flags directly to pnpm scripts", () => {
    expect(
      buildScenarioCommandArgs({
        kind: "health",
        name: "Private /health command",
        script: "smoke:telegram-user",
        args: ["--api-id", "12345", "--api-hash", "hash"],
      }),
    ).toEqual(["pnpm", "--silent", "smoke:telegram-user", "--api-id", "12345", "--api-hash", "hash"]);
  });

  it("returns a dry-run plan from argv without guard variables", async () => {
    const result = await createLiveValidationSuiteResult({
      plan: buildLiveValidationPlan({}),
      argv: ["--dry-run"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      status: "dry-run",
      scenarios: [{ kind: "preflight", script: "smoke:preflight", argKeys: [] }],
    });
  });

  it("returns blocked when required user credentials are missing", async () => {
    const result = await createLiveValidationSuiteResult({
      plan: buildLiveValidationPlan({
        requireUserSmoke: true,
      }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.report).toMatchObject({
      status: "blocked",
      issues: ["--api-id and --api-hash are required for user-account smoke scenarios."],
    });
  });

  it("returns a dry-run plan without secret values", async () => {
    const result = await createLiveValidationSuiteResult({
      plan: buildLiveValidationPlan({
        apiId: 12345,
        apiHash: "secret-hash",
        dryRun: true,
        scenarios: ["usage"],
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report).toEqual({
      status: "dry-run",
      skipped: ["preflight excluded by --scenario."],
      scenarios: [
        {
          kind: "usage",
          name: "Private /usage command",
          script: "smoke:telegram-user",
          argKeys: ["--api-hash", "--api-id", "--bot-username", "--message", "--target"],
        },
      ],
    });
    expect(JSON.stringify(result.report)).not.toContain("secret-hash");
  });

  it("runs scenarios sequentially and reports success", async () => {
    const run = vi.fn(
      async (item: LiveValidationScenario): Promise<ScenarioResult> => ({
        kind: item.kind,
        name: item.name,
        script: item.script,
        status: "passed",
        exitCode: 0,
        output: { status: "passed" },
      }),
    );
    const plan = buildLiveValidationPlan({
      apiId: 12345,
      apiHash: "hash",
      scenarios: ["health", "usage"],
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
    const run = vi.fn(
      async (item: LiveValidationScenario): Promise<ScenarioResult> => ({
        kind: item.kind,
        name: item.name,
        script: item.script,
        status: item.kind === "usage" ? "failed" : "passed",
        exitCode: item.kind === "usage" ? 1 : 0,
        output: { status: item.kind === "usage" ? "timeout" : "passed" },
      }),
    );
    const plan = buildLiveValidationPlan({
      apiId: 12345,
      apiHash: "hash",
      scenarios: ["health", "usage"],
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
