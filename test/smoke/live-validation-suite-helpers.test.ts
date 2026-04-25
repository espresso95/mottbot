import { describe, expect, it } from "vitest";
import { buildLiveValidationPlan } from "../../scripts/smoke/live-validation-suite-helpers.js";

describe("live validation suite helpers", () => {
  it("always enables the suite plan", () => {
    expect(buildLiveValidationPlan({ dryRun: false })).toEqual({
      enabled: true,
      dryRun: false,
      scenarios: [{ kind: "preflight", name: "Live preflight", script: "smoke:preflight", args: [] }],
      skipped: ["--api-id and --api-hash are required for user-account smoke scenarios."],
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
        args: [],
      },
    ]);
    expect(plan.skipped).toContain("--api-id and --api-hash are required for user-account smoke scenarios.");
    expect(plan.issues).toEqual([]);
  });

  it("does not require user credentials when the scenario filter selects only preflight", () => {
    const plan = buildLiveValidationPlan({ scenarios: ["preflight"] });

    expect(plan.scenarios.map((scenario) => scenario.kind)).toEqual(["preflight"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.issues).toEqual([]);
  });

  it("builds user, group, and file scenarios from CLI options", () => {
    const plan = buildLiveValidationPlan({
      apiId: 12345,
      apiHash: "hash",
      botUsername: "@StartupMottBot",
      dryRun: true,
      groupTarget: "Test Group",
      groupUnmentionedMessage: "unmentioned smoke",
      noReplyTimeoutMs: 7000,
      filePaths: ["/tmp/a.txt", "/tmp/b.png"],
      forceDocument: true,
      fileExpectReplyContains: "fixture-token",
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
      "group_unmentioned",
      "file",
      "file",
    ]);
    expect(plan.scenarios.find((scenario) => scenario.kind === "group_mention")?.args).toEqual(
      expect.arrayContaining([
        "--target",
        "Test Group",
        "--message",
        "@StartupMottBot run a short live validation health reply.",
      ]),
    );
    expect(plan.scenarios.find((scenario) => scenario.kind === "group_unmentioned")?.args).toEqual(
      expect.arrayContaining([
        "--target",
        "Test Group",
        "--message",
        "unmentioned smoke",
        "--no-expect-reply",
        "--timeout-ms",
        "7000",
      ]),
    );
    expect(plan.scenarios.find((scenario) => scenario.kind === "file")?.args).toEqual(
      expect.arrayContaining([
        "--file-path",
        "/tmp/a.txt",
        "--force-document",
        "--expect-reply-contains",
        "fixture-token",
      ]),
    );
  });

  it("reports a blocking issue when user smoke is required without credentials", () => {
    const plan = buildLiveValidationPlan({ requireUserSmoke: true });

    expect(plan.issues).toEqual(["--api-id and --api-hash are required for user-account smoke scenarios."]);
  });
});
