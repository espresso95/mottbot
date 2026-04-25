import path from "node:path";
import type { CodexCliRun, ProjectStatusSnapshot, ProjectSubtask, ProjectTask } from "./project-types.js";

type ProjectPlanSummary = {
  steps: ReadonlyArray<{ title: string; dependsOnStepIds: readonly string[] }>;
};

const COMPACT_ID_LENGTH = 6;
const COMPACT_SUMMARY_CHARS = 1_400;
const COMPACT_TASK_LIST_LIMIT = 4;
const TITLE_MAX_CHARS = 56;
const TRAILING_TITLE_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function compactId(id: string, length = COMPACT_ID_LENGTH): string {
  const cleaned = id.replace(/[^a-z0-9]/gi, "");
  return (cleaned || id).slice(0, length).toUpperCase();
}

/** Formats a compact, user-facing project task id for Telegram messages. */
export function projectDisplayId(taskId: string): string {
  return `PM-${compactId(taskId)}`;
}

/** Formats the short approval ID shown in Telegram project messages. */
function projectApprovalDisplayId(approvalId: string): string {
  return `PA-${compactId(approvalId)}`;
}

/** Normalizes a user-provided project reference for prefix matching. */
function projectReferenceKey(value: string): string {
  const normalized = value
    .trim()
    .replace(/^PM-/i, "")
    .replace(/[^a-z0-9]/gi, "");
  return normalized.toLowerCase();
}

/** Checks whether a user-provided project reference resolves to a task id. */
export function projectReferenceMatches(taskId: string, reference: string): boolean {
  const ref = reference.trim();
  if (!ref) {
    return false;
  }
  if (taskId === ref || projectDisplayId(taskId).toLowerCase() === ref.toLowerCase()) {
    return true;
  }
  if (ref.length >= 4 && taskId.toLowerCase().startsWith(ref.toLowerCase())) {
    return true;
  }
  const compactRef = projectReferenceKey(ref);
  return compactRef.length >= 4 && projectReferenceKey(taskId).startsWith(compactRef);
}

/** Builds a short project title from the original operator prompt. */
export function buildProjectTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/\r?\n/g, " ")
    .replace(/^iteration\s+\d+\s+(?:for\s+[^:]+)?\s*:\s*/i, "")
    .replace(/^phase\s+\d+\s*:\s*/i, "")
    .replace(/\b(?:for|in|inside)\s+the\s+tiny\s+game\b/gi, "")
    .replace(/\busing\s+project\s+mode\b/gi, "")
    .replace(/[`*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const firstClause = cleaned.split(/\s+(?:and then|then|after that|also)\s+/i)[0]?.trim() || cleaned;
  const firstSentence = firstClause.split(/[.!?]\s+/)[0]?.trim() || firstClause;
  const words = trimTrailingTitleWords(firstSentence.split(/\s+/).filter(Boolean).slice(0, 8));
  const trimmed = words.slice(0, 8).join(" ");
  const bounded = trimmed.length > TITLE_MAX_CHARS ? `${trimmed.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}...` : trimmed;
  return capitalize(bounded || "Project task");
}

/** Selects the best user-facing title for a project task. */
export function projectDisplayTitle(task: Pick<ProjectTask, "title" | "originalPrompt">): string {
  const fromPrompt = buildProjectTitle(task.originalPrompt);
  return fromPrompt === "Project task" ? task.title : fromPrompt;
}

/** Selects the best user-facing title for a project subtask. */
export function projectSubtaskDisplayTitle(subtask: Pick<ProjectSubtask, "title" | "prompt" | "role">): string {
  if (subtask.role !== "worker") {
    return subtask.title;
  }
  const fromPrompt = buildProjectTitle(subtask.prompt);
  if (fromPrompt.split(/\s+/).length <= 1 && subtask.title.trim().split(/\s+/).length > 1) {
    return subtask.title;
  }
  return fromPrompt === "Project task" ? subtask.title : fromPrompt;
}

/** Returns the basename shown for a project repository path. */
function repoDisplayName(repoRoot: string): string {
  return path.basename(repoRoot) || repoRoot;
}

/** Formats the approval prompt shown before starting a planned project task. */
export function formatProjectStartApproval(params: {
  task: ProjectTask;
  approvalId: string;
  plan: ProjectPlanSummary;
}): string {
  const steps = params.plan.steps.slice(0, 3).map((step, index) => `- ${index + 1}. ${step.title}`);
  const remaining = params.plan.steps.length - steps.length;
  return [
    "Project ready to start",
    `Task: ${projectDisplayTitle(params.task)} (${projectDisplayId(params.task.taskId)})`,
    `Repo: ${repoDisplayName(params.task.repoRoot)}`,
    `Plan: ${params.plan.steps.length} ${params.plan.steps.length === 1 ? "step" : "steps"}`,
    ...steps,
    remaining > 0 ? `- +${remaining} more` : undefined,
    "",
    `Approval: ${projectApprovalDisplayId(params.approvalId)}`,
    "Use the button below, or run:",
    `/project approve ${params.approvalId}`,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

/** Formats the acknowledgement shown after a project task is queued. */
export function formatProjectStarted(task: ProjectTask): string {
  return [
    "Project queued",
    `Task: ${projectDisplayTitle(task)} (${projectDisplayId(task.taskId)})`,
    `Repo: ${repoDisplayName(task.repoRoot)}`,
    "Status: waiting for the scheduler",
    `Details: /project details ${projectDisplayId(task.taskId)}`,
  ].join("\n");
}

/** Formats the acknowledgement shown after start approval is accepted. */
export function formatProjectStartApproved(task: ProjectTask): string {
  return [
    "Project approved",
    `Task: ${projectDisplayTitle(task)} (${projectDisplayId(task.taskId)})`,
    "Status: queued",
    `Details: /project details ${projectDisplayId(task.taskId)}`,
  ].join("\n");
}

/** Formats the compact project status response for Telegram. */
export function formatProjectStatus(params: {
  snapshot: ProjectStatusSnapshot;
  latestRuns: ReadonlyMap<string, CodexCliRun | undefined>;
}): string {
  const task = params.snapshot.task;
  const lines = [
    `Project: ${projectDisplayTitle(task)} (${projectDisplayId(task.taskId)})`,
    `Status: ${formatTaskStage(params.snapshot)}`,
    `Repo: ${repoDisplayName(task.repoRoot)}`,
    formatProgressLine(params.snapshot),
    params.snapshot.activeRuns.length > 0 ? `Active Codex runs: ${params.snapshot.activeRuns.length}` : undefined,
    task.lastError ? `Needs attention: ${task.lastError}` : undefined,
    "",
    "Subtasks:",
    ...formatCompactSubtaskLines(params.snapshot.subtasks, params.latestRuns),
    "",
    ...formatNextActionLines(task),
  ];
  return lines.filter((line): line is string => typeof line === "string").join("\n");
}

/** Formats a detailed project diagnostic response for Telegram. */
export function formatProjectDetails(params: {
  snapshot: ProjectStatusSnapshot;
  latestRuns: ReadonlyMap<string, CodexCliRun | undefined>;
}): string {
  const task = params.snapshot.task;
  const subtaskLines =
    params.snapshot.subtasks
      .map((subtask) => formatSubtaskDetailLine(subtask, params.latestRuns.get(subtask.subtaskId)))
      .join("\n") || "- none";
  return [
    "Project details",
    `Title: ${projectDisplayTitle(task)}`,
    projectDisplayTitle(task) !== task.title ? `Stored title: ${task.title}` : undefined,
    `Display ID: ${projectDisplayId(task.taskId)}`,
    `Task ID: ${task.taskId}`,
    `Status: ${task.status}`,
    `Repo: ${task.repoRoot}`,
    `Base ref: ${task.baseRef}`,
    task.finalBranch ? `Final branch: ${task.finalBranch}` : undefined,
    task.integrationWorktreePath ? `Integration worktree: ${task.integrationWorktreePath}` : undefined,
    `Active runs: ${params.snapshot.activeRuns.length}`,
    "",
    "Subtasks:",
    subtaskLines,
    task.finalDiffStat ? "" : undefined,
    task.finalDiffStat ? "Diff stat:" : undefined,
    task.finalDiffStat,
    task.finalSummary ? "" : undefined,
    task.finalSummary ? "Summary:" : undefined,
    task.finalSummary,
    task.lastError ? "" : undefined,
    task.lastError ? "Last error:" : undefined,
    task.lastError,
    "",
    ...formatNextActionLines(task, { includeDetails: false, useFullId: true }),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

/** Formats the project completion report after review succeeds. */
export function formatProjectCompletionReport(params: { task: ProjectTask; reviewSummary?: string }): string {
  const task = params.task;
  const summary = compactText(params.reviewSummary ?? task.finalSummary ?? "Review completed.", COMPACT_SUMMARY_CHARS);
  return [
    "Project review passed",
    `Task: ${projectDisplayTitle(task)} (${projectDisplayId(task.taskId)})`,
    task.finalBranch ? `Branch: ${task.finalBranch}` : undefined,
    "",
    summary,
    "",
    ...formatNextActionLines(task),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n")
    .slice(0, 3_900);
}

/** Formats the approval prompt shown before publishing integrated project work. */
export function formatProjectPublishApproval(params: {
  task: ProjectTask;
  approvalId: string;
  action: string;
}): string {
  return [
    "Project publish approval",
    `Task: ${projectDisplayTitle(params.task)} (${projectDisplayId(params.task.taskId)})`,
    `Action: ${params.action}`,
    `Approval: ${projectApprovalDisplayId(params.approvalId)}`,
    "",
    "Use the button below, or run:",
    `/project approve ${params.approvalId}`,
  ].join("\n");
}

/** Formats the Telegram notification after project work is published. */
export function formatProjectPublished(params: { task: ProjectTask; publishSummary: string }): string {
  return [
    "Project published",
    `Task: ${projectDisplayTitle(params.task)} (${projectDisplayId(params.task.taskId)})`,
    "",
    params.publishSummary || "Publish completed.",
    "",
    `Clean up: /project cleanup ${projectDisplayId(params.task.taskId)}`,
  ].join("\n");
}

/** Formats the Telegram notification after project worktree cleanup. */
export function formatProjectCleanup(params: { task: ProjectTask; cleanupSummary?: string; removed: boolean }): string {
  return [
    params.removed ? "Project cleaned up" : "Nothing to clean up",
    `Task: ${projectDisplayTitle(params.task)} (${projectDisplayId(params.task.taskId)})`,
    params.cleanupSummary,
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

function formatTaskStage(snapshot: ProjectStatusSnapshot): string {
  const task = snapshot.task;
  if (task.status === "running") {
    const runningWorkers = snapshot.subtasks.filter(
      (subtask) => subtask.role === "worker" && subtask.status === "running",
    ).length;
    return runningWorkers > 0 ? `Coding (${runningWorkers} active)` : "Coding";
  }
  if (task.status === "integrating") {
    return "Integrating worker branches";
  }
  if (task.status === "reviewing") {
    return "Reviewing integrated result";
  }
  if (task.status === "completed") {
    return "Review passed";
  }
  return humanize(task.status);
}

function formatProgressLine(snapshot: ProjectStatusSnapshot): string {
  const workers = snapshot.subtasks.filter((subtask) => subtask.role === "worker");
  if (workers.length === 0) {
    return `Steps: ${snapshot.subtasks.length}`;
  }
  const completed = workers.filter((subtask) => subtask.status === "completed").length;
  const failed = workers.filter((subtask) => ["failed", "cancelled", "skipped"].includes(subtask.status)).length;
  const active = workers.filter((subtask) => ["queued", "ready", "running"].includes(subtask.status)).length;
  const parts = [`Workers: ${completed}/${workers.length} complete`];
  if (active > 0) {
    parts.push(`${active} active or queued`);
  }
  if (failed > 0) {
    parts.push(`${failed} blocked`);
  }
  return parts.join(", ");
}

function formatCompactSubtaskLines(
  subtasks: ProjectSubtask[],
  latestRuns: ReadonlyMap<string, CodexCliRun | undefined>,
): string[] {
  const visible = subtasks.slice(0, COMPACT_TASK_LIST_LIMIT).map((subtask) => {
    const run = latestRuns.get(subtask.subtaskId);
    const runDetail = run ? `; run ${humanize(run.status)}${formatRunOutcome(run)}` : "";
    const error = subtask.lastError ? `; ${compactText(subtask.lastError, 100)}` : "";
    return `- ${capitalize(subtask.role)}: ${projectSubtaskDisplayTitle(subtask)} - ${humanize(
      subtask.status,
    )}${runDetail}${error}`;
  });
  const remaining = subtasks.length - visible.length;
  if (remaining > 0) {
    visible.push(`- +${remaining} more in details`);
  }
  return visible.length > 0 ? visible : ["- none yet"];
}

function formatSubtaskDetailLine(subtask: ProjectSubtask, latestRun: CodexCliRun | undefined): string {
  const deps =
    subtask.dependsOnSubtaskIds.length > 0
      ? ` (depends on ${subtask.dependsOnSubtaskIds.map((entry) => entry.slice(0, 8)).join(", ")})`
      : "";
  const error = subtask.lastError ? `; error: ${subtask.lastError}` : "";
  const runDetail = latestRun ? `; latest run ${latestRun.status}${formatRunOutcome(latestRun)}` : "";
  return `- ${subtask.subtaskId.slice(0, 8)} ${projectSubtaskDisplayTitle(subtask)}: ${
    subtask.status
  }${deps}${error}${runDetail}`;
}

function formatRunOutcome(run: CodexCliRun): string {
  if (run.lastError) {
    return `: ${run.lastError}`;
  }
  if (typeof run.exitCode === "number") {
    return `: exit ${run.exitCode}`;
  }
  if (run.signal) {
    return `: signal ${run.signal}`;
  }
  return "";
}

function formatNextActionLines(
  task: ProjectTask,
  options: { includeDetails?: boolean; useFullId?: boolean } = {},
): string[] {
  const includeDetails = options.includeDetails ?? true;
  const id = options.useFullId ? task.taskId : projectDisplayId(task.taskId);
  const lines: string[] = ["Next:"];
  if (task.status === "completed" && task.finalBranch && task.integrationWorktreePath) {
    lines.push(`Publish to main: /project publish ${id} main`);
    lines.push(`Create PR: /project publish ${id} pr`);
  }
  if (task.integrationWorktreePath && ["completed", "failed", "cancelled"].includes(task.status)) {
    lines.push(`Clean up: /project cleanup ${id}`);
  }
  if (includeDetails) {
    lines.push(`Details: /project details ${id}`);
  }
  if (lines.length === 1) {
    lines.push(includeDetails ? `Details: /project details ${id}` : "No action needed right now.");
  }
  return lines;
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 3).trimEnd()}...` : normalized;
}

function trimTrailingTitleWords(words: string[]): string[] {
  const next = [...words];
  while (next.length > 1) {
    const last = next
      .at(-1)
      ?.replace(/[^a-z]/gi, "")
      .toLowerCase();
    if (!last || !TRAILING_TITLE_WORDS.has(last)) {
      break;
    }
    next.pop();
  }
  return next;
}

function humanize(value: string): string {
  return value.split(/[_-]+/).filter(Boolean).map(capitalize).join(" ");
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
