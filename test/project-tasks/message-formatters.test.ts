import { describe, expect, it } from "vitest";
import type {
  CodexCliRun,
  ProjectStatusSnapshot,
  ProjectSubtask,
  ProjectTask,
} from "../../src/project-tasks/project-types.js";
import {
  buildProjectTitle,
  formatProjectCompletionReport,
  formatProjectDetails,
  formatProjectStartApproval,
  formatProjectStatus,
  projectDisplayId,
  projectDisplayTitle,
  projectReferenceMatches,
  projectSubtaskDisplayTitle,
} from "../../src/project-tasks/project-message-formatters.js";

const taskId = "123e4567-e89b-12d3-a456-426614174000";
const subtaskId = "223e4567-e89b-12d3-a456-426614174000";

function baseTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    taskId,
    chatId: "chat",
    repoRoot: "/tmp/mottbot-projects/tiny-game",
    baseRef: "main",
    title: "Add combo streak scoring",
    originalPrompt: "add combo streak scoring",
    status: "running",
    maxParallelWorkers: 2,
    maxAttemptsPerSubtask: 2,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function subtask(overrides: Partial<ProjectSubtask> = {}): ProjectSubtask {
  return {
    subtaskId,
    taskId,
    title: "Implement scoring",
    role: "worker",
    prompt: "implement scoring",
    dependsOnSubtaskIds: [],
    status: "running",
    attempt: 1,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function snapshot(overrides: Partial<ProjectTask> = {}): ProjectStatusSnapshot {
  return {
    task: baseTask(overrides),
    subtasks: [subtask()],
    activeRuns: [],
  };
}

describe("Project Mode message formatters", () => {
  it("builds readable display ids and titles from noisy project prompts", () => {
    expect(projectDisplayId(taskId)).toBe("PM-123E45");
    expect(projectReferenceMatches(taskId, "PM-123E45")).toBe(true);
    expect(projectReferenceMatches(taskId, "123e")).toBe(true);
    expect(
      buildProjectTitle("Iteration 1 for the tiny game: add a simple combo streak scoring feature and then test it"),
    ).toBe("Add a simple combo streak scoring feature");
    expect(
      projectDisplayTitle(
        baseTask({
          title: "Iteration 1 for the tiny game: add a",
          originalPrompt: "Iteration 1 for the tiny game: add a simple combo streak scoring feature for the board",
        }),
      ),
    ).toBe("Add a simple combo streak scoring feature");
    expect(
      projectSubtaskDisplayTitle(
        subtask({
          title: "Iteration 1 for the tiny game: add a",
          prompt: "Iteration 1 for the tiny game: add a simple combo streak scoring feature for the board",
        }),
      ),
    ).toBe("Add a simple combo streak scoring feature");
    expect(
      projectSubtaskDisplayTitle(
        subtask({
          title: "Review integrated result",
          role: "reviewer",
          prompt: "Review the integrated result for this Mottbot project task.",
        }),
      ),
    ).toBe("Review integrated result");
  });

  it("formats approval prompts with compact task context and a fallback command", () => {
    const text = formatProjectStartApproval({
      task: baseTask({ status: "awaiting_approval" }),
      approvalId: "approval-123456789",
      plan: {
        steps: [
          { title: "Implement scoring", dependsOnStepIds: [] },
          { title: "Add tests", dependsOnStepIds: ["step-1"] },
        ],
      },
    });

    expect(text).toContain("Project ready to start");
    expect(text).toContain("Task: Add combo streak scoring (PM-123E45)");
    expect(text).toContain("Repo: tiny-game");
    expect(text).toContain("/project approve approval-123456789");
  });

  it("keeps status compact while preserving run errors", () => {
    const run: CodexCliRun = {
      cliRunId: "run-1",
      taskId,
      subtaskId,
      commandJson: "[]",
      cwd: "/tmp/mottbot-projects/tiny-game",
      status: "failed",
      stdoutLogPath: "/tmp/stdout.log",
      stderrLogPath: "/tmp/stderr.log",
      jsonlLogPath: "/tmp/events.jsonl",
      updatedAt: 3,
      lastError: "Codex CLI run was interrupted by process restart.",
    };
    const text = formatProjectStatus({
      snapshot: snapshot(),
      latestRuns: new Map([[subtaskId, run]]),
    });

    expect(text).toContain("Project: Add combo streak scoring (PM-123E45)");
    expect(text).toContain("Repo: tiny-game");
    expect(text).not.toContain("/tmp/mottbot-projects");
    expect(text).toContain("Worker: Implement scoring - Running; run Failed");
    expect(text).toContain("Codex CLI run was interrupted by process restart.");
    expect(text).toContain("Details: /project details PM-123E45");
  });

  it("keeps details verbose for operator diagnosis", () => {
    const text = formatProjectDetails({
      snapshot: snapshot({
        status: "completed",
        finalBranch: "mottbot/task/integration",
        integrationWorktreePath: "/tmp/mottbot-projects/integration",
        finalDiffStat: "1 file changed",
        finalSummary: "Review passed.",
      }),
      latestRuns: new Map(),
    });

    expect(text).toContain(`Task ID: ${taskId}`);
    expect(text).toContain("Repo: /tmp/mottbot-projects/tiny-game");
    expect(text).toContain("Final branch: mottbot/task/integration");
    expect(text).toContain("Diff stat:");
    expect(text).toContain("Summary:");
  });

  it("formats completion reports with publish and cleanup next steps", () => {
    const text = formatProjectCompletionReport({
      task: baseTask({
        status: "completed",
        finalBranch: "mottbot/task/integration",
        integrationWorktreePath: "/tmp/mottbot-projects/integration",
      }),
      reviewSummary: "No blocking issues found. Checks passed.",
    });

    expect(text).toContain("Project review passed");
    expect(text).toContain("No blocking issues found. Checks passed.");
    expect(text).toContain("Publish to main: /project publish PM-123E45 main");
    expect(text).toContain("Clean up: /project cleanup PM-123E45");
  });
});
