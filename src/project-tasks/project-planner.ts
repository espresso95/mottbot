/** One generated project step with dependency ids from the same plan. */
type ProjectPlanStep = {
  stepId: string;
  title: string;
  prompt: string;
  dependsOnStepIds: string[];
};

/** Deterministic project plan used to seed project-mode subtasks. */
type ProjectPlan = {
  title: string;
  steps: ProjectPlanStep[];
};

function toStepId(index: number): string {
  return `step-${index + 1}`;
}

/** Builds a simple ordered plan from checklist-style prompt lines or the full prompt. */
export function buildProjectPlan(input: { prompt: string; taskTitle: string }): ProjectPlan {
  const rawLines = input.prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const checklistLines = rawLines
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);

  const seeds = checklistLines.length > 0 ? checklistLines : [input.prompt.trim()];
  const steps = seeds.map(
    (seed, index): ProjectPlanStep => ({
      stepId: toStepId(index),
      title: seed.split(/\s+/).slice(0, 8).join(" "),
      prompt: seed,
      dependsOnStepIds: index === 0 ? [] : [toStepId(index - 1)],
    }),
  );

  return {
    title: input.taskTitle,
    steps,
  };
}
