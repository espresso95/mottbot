import { describe, expect, it } from "vitest";
import { buildLiveValidationPlan } from "../../src/tools/live-validation-suite-helpers.js";

describe("live validation suite helpers", () => {
  it("always enables the suite plan", () => {
    expect(
      buildLiveValidationPlan({
        MOTTBOT_LIVE_VALIDATION_DRY_RUN: "false",
      }),
    ).toEqual({
      enabled: true,
      dryRun: false,
      scenarios: [{ kind: "preflight", name: "Live preflight", script: "smoke:preflight", env: {} }],
      skipped: ["TELEGRAM_API_ID and TELEGRAM_API_HASH are required for user-account smoke scenarios."],
      issues: [],
    });
  });

  it("builds a preflight-only plan without user credentials", () => {
    const plan = buildLiveValidationPlan({});

    expect(plan.enabled).toBe(true);
    expect(plan.scenarios).toEqual([
      {
        kind: "preflight",
        name: "Live preflight",
        script: "smoke:preflight",
        env: {},
      },
    ]);
    expect(plan.skipped).toContain(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH are required for user-account smoke scenarios.",
    );
    expect(plan.issues).toEqual([]);
  });

  it("does not require user credentials when the scenario filter selects only preflight", () => {
    const plan = buildLiveValidationPlan({
      MOTTBOT_LIVE_VALIDATION_SCENARIOS: "preflight",
    });

    expect(plan.scenarios.map((scenario) => scenario.kind)).toEqual(["preflight"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.issues).toEqual([]);
  });

  it("builds user, group, and file scenarios from env", () => {
    const plan = buildLiveValidationPlan({
      TELEGRAM_API_ID: "12345",
      TELEGRAM_API_HASH: "hash",
      MOTTBOT_LIVE_BOT_USERNAME: "@StartupMottBot",
      MOTTBOT_LIVE_VALIDATION_DRY_RUN: "true",
      MOTTBOT_LIVE_VALIDATION_GROUP_TARGET: "Test Group",
      MOTTBOT_LIVE_VALIDATION_FILE_PATHS: "/tmp/a.txt, /tmp/b.png",
      MOTTBOT_LIVE_VALIDATION_FORCE_DOCUMENT: "true",
    });

    expect(plan.dryRun).toBe(true);
    expect(plan.issues).toEqual([]);
    expect(plan.scenarios.map((scenario) => scenario.kind)).toEqual([
      "preflight",
      "private",
      "health",
      "usage",
      "reply",
      "group_mention",
      "file",
      "file",
    ]);
    expect(plan.scenarios.find((scenario) => scenario.kind === "group_mention")?.env).toMatchObject({
      MOTTBOT_USER_SMOKE_TARGET: "Test Group",
      MOTTBOT_USER_SMOKE_MESSAGE: "@StartupMottBot run a short live validation health reply.",
    });
    expect(plan.scenarios.find((scenario) => scenario.kind === "file")?.env).toMatchObject({
      MOTTBOT_USER_SMOKE_FILE_PATH: "/tmp/a.txt",
      MOTTBOT_USER_SMOKE_FORCE_DOCUMENT: "true",
    });
  });

  it("reports a blocking issue when user smoke is required without credentials", () => {
    const plan = buildLiveValidationPlan({
      MOTTBOT_LIVE_VALIDATION_REQUIRE_USER_SMOKE: "true",
    });

    expect(plan.issues).toEqual([
      "TELEGRAM_API_ID and TELEGRAM_API_HASH are required for user-account smoke scenarios.",
    ]);
  });
});
