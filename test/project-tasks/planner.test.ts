import { describe, expect, it } from "vitest";
import { buildProjectPlan } from "../../src/project-tasks/project-planner.js";

describe("buildProjectPlan", () => {
  it("builds sequential dependencies from checklist prompts", () => {
    const plan = buildProjectPlan({
      taskTitle: "phase3",
      prompt: "- collect requirements\n- implement features\n- run tests",
    });

    expect(plan.steps).toHaveLength(3);
    expect(plan.steps[0]?.dependsOnStepIds).toEqual([]);
    expect(plan.steps[1]?.dependsOnStepIds).toEqual(["step-1"]);
    expect(plan.steps[2]?.dependsOnStepIds).toEqual(["step-2"]);
  });
});
