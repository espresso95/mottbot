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

export type ProjectSubtaskStatus =
  | "queued"
  | "blocked"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type CodexCliRunStatus = "starting" | "streaming" | "exited" | "failed" | "cancelled" | "timed_out";

export type ProjectTask = {
  taskId: string;
  chatId: string;
  requestedByUserId?: string;
  requestedByUsername?: string;
  repoRoot: string;
  baseRef: string;
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
};

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

export type ProjectApproval = {
  approvalId: string;
  taskId: string;
  kind: "start_project";
  status: "pending" | "approved" | "rejected" | "expired";
  requestedBy?: string;
  decidedBy?: string;
  requestJson: string;
  decisionNote?: string;
  createdAt: number;
  decidedAt?: number;
  expiresAt?: number;
};

export type ProjectStatusSnapshot = {
  task: ProjectTask;
  subtasks: ProjectSubtask[];
  activeRuns: CodexCliRun[];
};
