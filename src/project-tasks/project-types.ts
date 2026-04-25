/** Lifecycle state for a multi-worker project task. */
export type ProjectTaskStatus =
  | "draft"
  | "awaiting_approval"
  | "planning"
  | "queued"
  | "running"
  | "paused"
  | "integrating"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

/** Lifecycle state for an individual project subtask. */
export type ProjectSubtaskStatus =
  | "queued"
  | "blocked"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

/** Process state for one Codex CLI worker invocation. */
export type CodexCliRunStatus = "starting" | "streaming" | "exited" | "failed" | "cancelled" | "timed_out";

/** Approval kinds for gated project-mode actions. */
export type ProjectApprovalKind =
  | "start_project"
  | "start_worker"
  | "merge"
  | "push"
  | "deploy"
  | "destructive_git"
  | "dangerous_sandbox";

/** Persisted project-mode task requested from Telegram. */
export type ProjectTask = {
  taskId: string;
  chatId: string;
  requestedByUserId?: string;
  requestedByUsername?: string;
  repoRoot: string;
  baseRef: string;
  integrationBranch?: string;
  integrationWorktreePath?: string;
  title: string;
  originalPrompt: string;
  planJson?: string;
  status: ProjectTaskStatus;
  maxParallelWorkers: number;
  maxAttemptsPerSubtask: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  finalSummary?: string;
  finalBranch?: string;
  finalDiffStat?: string;
};

/** Persisted unit of Codex worker, integrator, planner, or reviewer work. */
export type ProjectSubtask = {
  subtaskId: string;
  taskId: string;
  title: string;
  role: "planner" | "worker" | "integrator" | "reviewer";
  prompt: string;
  dependsOnSubtaskIds: string[];
  status: ProjectSubtaskStatus;
  branchName?: string;
  worktreePath?: string;
  codexSessionId?: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  resultSummary?: string;
  lastError?: string;
};

/** Persisted metadata and artifact paths for one Codex CLI subprocess. */
export type CodexCliRun = {
  cliRunId: string;
  taskId: string;
  subtaskId?: string;
  pid?: number;
  commandJson: string;
  cwd: string;
  status: CodexCliRunStatus;
  exitCode?: number;
  signal?: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  jsonlLogPath: string;
  finalMessagePath?: string;
  startedAt?: number;
  updatedAt: number;
  finishedAt?: number;
  lastError?: string;
};

/** Operator approval record required before a project task starts. */
export type ProjectApproval = {
  approvalId: string;
  taskId: string;
  kind: ProjectApprovalKind;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedBy?: string;
  decidedBy?: string;
  requestJson: string;
  decisionNote?: string;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
};

/** Combined task status view returned by project status commands. */
export type ProjectStatusSnapshot = {
  task: ProjectTask;
  subtasks: ProjectSubtask[];
  activeRuns: CodexCliRun[];
};
