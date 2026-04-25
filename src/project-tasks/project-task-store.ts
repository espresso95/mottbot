import type { DatabaseClient } from "../db/client.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type {
  CodexCliRun,
  CodexCliRunStatus,
  ProjectApproval,
  ProjectStatusSnapshot,
  ProjectSubtask,
  ProjectSubtaskStatus,
  ProjectTask,
  ProjectTaskStatus,
} from "./project-types.js";

type ProjectTaskRow = {
  task_id: string;
  chat_id: string;
  requested_by_user_id: string | null;
  requested_by_username: string | null;
  repo_root: string;
  base_ref: string;
  title: string;
  original_prompt: string;
  plan_json: string | null;
  status: ProjectTaskStatus;
  max_parallel_workers: number;
  max_attempts_per_subtask: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  final_summary: string | null;
  final_branch: string | null;
};

type ProjectSubtaskRow = {
  subtask_id: string;
  task_id: string;
  title: string;
  role: "planner" | "worker" | "integrator" | "reviewer";
  prompt: string;
  depends_on_json: string;
  status: ProjectSubtaskStatus;
  branch_name: string | null;
  worktree_path: string | null;
  codex_session_id: string | null;
  attempt: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  result_summary: string | null;
  last_error: string | null;
};

type CodexCliRunRow = {
  cli_run_id: string;
  task_id: string;
  subtask_id: string | null;
  pid: number | null;
  command_json: string;
  cwd: string;
  status: CodexCliRunStatus;
  exit_code: number | null;
  signal: string | null;
  stdout_log_path: string;
  stderr_log_path: string;
  jsonl_log_path: string;
  final_message_path: string | null;
  started_at: number | null;
  updated_at: number;
  finished_at: number | null;
  last_error: string | null;
};

type ProjectApprovalRow = {
  approval_id: string;
  task_id: string;
  kind: "start_project";
  status: "pending" | "approved" | "rejected" | "expired";
  requested_by: string | null;
  decided_by: string | null;
  request_json: string;
  decision_note: string | null;
  created_at: number;
  decided_at: number | null;
  expires_at: number | null;
};

function mapTask(row: ProjectTaskRow): ProjectTask {
  return {
    taskId: row.task_id,
    chatId: row.chat_id,
    ...(row.requested_by_user_id ? { requestedByUserId: row.requested_by_user_id } : {}),
    ...(row.requested_by_username ? { requestedByUsername: row.requested_by_username } : {}),
    repoRoot: row.repo_root,
    baseRef: row.base_ref,
    title: row.title,
    originalPrompt: row.original_prompt,
    ...(row.plan_json ? { planJson: row.plan_json } : {}),
    status: row.status,
    maxParallelWorkers: row.max_parallel_workers,
    maxAttemptsPerSubtask: row.max_attempts_per_subtask,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.final_summary ? { finalSummary: row.final_summary } : {}),
    ...(row.final_branch ? { finalBranch: row.final_branch } : {}),
  };
}

function mapSubtask(row: ProjectSubtaskRow): ProjectSubtask {
  return {
    subtaskId: row.subtask_id,
    taskId: row.task_id,
    title: row.title,
    role: row.role,
    prompt: row.prompt,
    dependsOnSubtaskIds: parseDependsOnJson(row.depends_on_json),
    status: row.status,
    ...(row.branch_name ? { branchName: row.branch_name } : {}),
    ...(row.worktree_path ? { worktreePath: row.worktree_path } : {}),
    ...(row.codex_session_id ? { codexSessionId: row.codex_session_id } : {}),
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function mapRun(row: CodexCliRunRow): CodexCliRun {
  return {
    cliRunId: row.cli_run_id,
    taskId: row.task_id,
    ...(row.subtask_id ? { subtaskId: row.subtask_id } : {}),
    ...(row.pid !== null ? { pid: row.pid } : {}),
    commandJson: row.command_json,
    cwd: row.cwd,
    status: row.status,
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.signal ? { signal: row.signal } : {}),
    stdoutLogPath: row.stdout_log_path,
    stderrLogPath: row.stderr_log_path,
    jsonlLogPath: row.jsonl_log_path,
    ...(row.final_message_path ? { finalMessagePath: row.final_message_path } : {}),
    ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
    updatedAt: row.updated_at,
    ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function mapApproval(row: ProjectApprovalRow): ProjectApproval {
  return {
    approvalId: row.approval_id,
    taskId: row.task_id,
    kind: row.kind,
    status: row.status,
    ...(row.requested_by ? { requestedBy: row.requested_by } : {}),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
    requestJson: row.request_json,
    ...(row.decision_note ? { decisionNote: row.decision_note } : {}),
    createdAt: row.created_at,
    ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}),
    ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
  };
}

function parseDependsOnJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}

export class ProjectTaskStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock,
  ) {}

  createTask(input: {
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
  }): ProjectTask {
    const now = this.clock.now();
    const task: ProjectTask = {
      taskId: createId(),
      chatId: input.chatId,
      ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
      ...(input.requestedByUsername ? { requestedByUsername: input.requestedByUsername } : {}),
      repoRoot: input.repoRoot,
      baseRef: input.baseRef,
      title: input.title,
      originalPrompt: input.originalPrompt,
      status: input.status,
      ...(input.planJson ? { planJson: input.planJson } : {}),
      maxParallelWorkers: input.maxParallelWorkers,
      maxAttemptsPerSubtask: input.maxAttemptsPerSubtask,
      createdAt: now,
      updatedAt: now,
    };
    this.database.db.prepare(`insert into project_tasks (
      task_id, chat_id, requested_by_user_id, requested_by_username, repo_root, base_ref, title, original_prompt,
      plan_json, status, max_parallel_workers, max_attempts_per_subtask, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task.taskId,
      task.chatId,
      task.requestedByUserId ?? null,
      task.requestedByUsername ?? null,
      task.repoRoot,
      task.baseRef,
      task.title,
      task.originalPrompt,
      task.planJson ?? null,
      task.status,
      task.maxParallelWorkers,
      task.maxAttemptsPerSubtask,
      task.createdAt,
      task.updatedAt,
    );
    return task;
  }

  createSubtask(input: {
    taskId: string;
    title: string;
    role: "planner" | "worker" | "integrator" | "reviewer";
    prompt: string;
    dependsOnSubtaskIds?: string[];
    status: ProjectSubtaskStatus;
  }): ProjectSubtask {
    const now = this.clock.now();
    const subtask: ProjectSubtask = {
      subtaskId: createId(),
      taskId: input.taskId,
      title: input.title,
      role: input.role,
      prompt: input.prompt,
      dependsOnSubtaskIds: input.dependsOnSubtaskIds ?? [],
      status: input.status,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.database.db.prepare(`insert into project_subtasks (
      subtask_id, task_id, title, role, prompt, depends_on_json, status, attempt, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      subtask.subtaskId,
      subtask.taskId,
      subtask.title,
      subtask.role,
      subtask.prompt,
      JSON.stringify(subtask.dependsOnSubtaskIds),
      subtask.status,
      subtask.attempt,
      subtask.createdAt,
      subtask.updatedAt,
    );
    return subtask;
  }

  getTask(taskId: string): ProjectTask | undefined {
    const row = this.database.db.prepare<unknown[], ProjectTaskRow>("select * from project_tasks where task_id = ?").get(taskId);
    return row ? mapTask(row) : undefined;
  }

  listTasksByChat(chatId: string, limit = 10): ProjectTask[] {
    return this.database.db
      .prepare<unknown[], ProjectTaskRow>("select * from project_tasks where chat_id = ? order by created_at desc limit ?")
      .all(chatId, Math.max(1, Math.min(50, limit)))
      .map(mapTask);
  }

  listRunnableTasks(limit = 20): ProjectTask[] {
    return this.database.db
      .prepare<unknown[], ProjectTaskRow>("select * from project_tasks where status in ('queued', 'running') order by updated_at asc limit ?")
      .all(Math.max(1, Math.min(limit, 100)))
      .map(mapTask);
  }

  listReadySubtasks(taskId: string): ProjectSubtask[] {
    return this.database.db
      .prepare<unknown[], ProjectSubtaskRow>("select * from project_subtasks where task_id = ? and status in ('ready', 'queued') order by created_at asc")
      .all(taskId)
      .map(mapSubtask);
  }

  listSubtasks(taskId: string): ProjectSubtask[] {
    return this.database.db
      .prepare<unknown[], ProjectSubtaskRow>("select * from project_subtasks where task_id = ? order by created_at asc")
      .all(taskId)
      .map(mapSubtask);
  }

  getSubtask(subtaskId: string): ProjectSubtask | undefined {
    const row = this.database.db
      .prepare<unknown[], ProjectSubtaskRow>("select * from project_subtasks where subtask_id = ?")
      .get(subtaskId);
    return row ? mapSubtask(row) : undefined;
  }

  updateTask(taskId: string, patch: Partial<Omit<ProjectTask, "taskId" | "chatId" | "repoRoot" | "baseRef" | "createdAt">>): ProjectTask {
    const current = this.getTask(taskId);
    if (!current) {
      throw new Error(`Unknown project task ${taskId}.`);
    }
    const next: ProjectTask = {
      ...current,
      ...patch,
      updatedAt: this.clock.now(),
    };
    this.database.db.prepare(`update project_tasks set
      requested_by_user_id=?, requested_by_username=?, title=?, original_prompt=?, plan_json=?, status=?, max_parallel_workers=?,
      max_attempts_per_subtask=?, updated_at=?, started_at=?, finished_at=?, last_error=?, final_summary=?, final_branch=?
      where task_id=?`).run(
      next.requestedByUserId ?? null,
      next.requestedByUsername ?? null,
      next.title,
      next.originalPrompt,
      next.planJson ?? null,
      next.status,
      next.maxParallelWorkers,
      next.maxAttemptsPerSubtask,
      next.updatedAt,
      next.startedAt ?? null,
      next.finishedAt ?? null,
      next.lastError ?? null,
      next.finalSummary ?? null,
      next.finalBranch ?? null,
      taskId,
    );
    return next;
  }

  updateSubtask(subtaskId: string, patch: Partial<Omit<ProjectSubtask, "subtaskId" | "taskId" | "createdAt">>): ProjectSubtask {
    const current = this.getSubtask(subtaskId);
    if (!current) {
      throw new Error(`Unknown project subtask ${subtaskId}.`);
    }
    const next: ProjectSubtask = {
      ...current,
      ...patch,
      updatedAt: this.clock.now(),
    };
    this.database.db.prepare(`update project_subtasks set
      title=?, role=?, prompt=?, depends_on_json=?, status=?, branch_name=?, worktree_path=?, codex_session_id=?, attempt=?, updated_at=?,
      started_at=?, finished_at=?, result_summary=?, last_error=? where subtask_id=?`).run(
      next.title,
      next.role,
      next.prompt,
      JSON.stringify(next.dependsOnSubtaskIds),
      next.status,
      next.branchName ?? null,
      next.worktreePath ?? null,
      next.codexSessionId ?? null,
      next.attempt,
      next.updatedAt,
      next.startedAt ?? null,
      next.finishedAt ?? null,
      next.resultSummary ?? null,
      next.lastError ?? null,
      subtaskId,
    );
    return next;
  }

  createCliRun(input: {
    taskId: string;
    subtaskId?: string;
    commandJson: string;
    cwd: string;
    stdoutLogPath: string;
    stderrLogPath: string;
    jsonlLogPath: string;
    finalMessagePath?: string;
  }): CodexCliRun {
    const now = this.clock.now();
    const run: CodexCliRun = {
      cliRunId: createId(),
      taskId: input.taskId,
      ...(input.subtaskId ? { subtaskId: input.subtaskId } : {}),
      commandJson: input.commandJson,
      cwd: input.cwd,
      status: "starting",
      stdoutLogPath: input.stdoutLogPath,
      stderrLogPath: input.stderrLogPath,
      jsonlLogPath: input.jsonlLogPath,
      ...(input.finalMessagePath ? { finalMessagePath: input.finalMessagePath } : {}),
      updatedAt: now,
    };
    this.database.db.prepare(`insert into codex_cli_runs (
      cli_run_id, task_id, subtask_id, command_json, cwd, status, stdout_log_path, stderr_log_path, jsonl_log_path,
      final_message_path, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.cliRunId,
      run.taskId,
      run.subtaskId ?? null,
      run.commandJson,
      run.cwd,
      run.status,
      run.stdoutLogPath,
      run.stderrLogPath,
      run.jsonlLogPath,
      run.finalMessagePath ?? null,
      run.updatedAt,
    );
    return run;
  }

  updateCliRun(cliRunId: string, patch: Partial<Omit<CodexCliRun, "cliRunId" | "taskId" | "commandJson" | "cwd" | "stdoutLogPath" | "stderrLogPath" | "jsonlLogPath">>): CodexCliRun {
    const currentRow = this.database.db
      .prepare<unknown[], CodexCliRunRow>("select * from codex_cli_runs where cli_run_id = ?")
      .get(cliRunId);
    if (!currentRow) {
      throw new Error(`Unknown cli run ${cliRunId}.`);
    }
    const current = mapRun(currentRow);
    const next: CodexCliRun = {
      ...current,
      ...patch,
      updatedAt: this.clock.now(),
    };
    this.database.db.prepare(`update codex_cli_runs set
      subtask_id=?, pid=?, status=?, exit_code=?, signal=?, final_message_path=?, started_at=?, updated_at=?, finished_at=?, last_error=?
      where cli_run_id=?`).run(
      next.subtaskId ?? null,
      next.pid ?? null,
      next.status,
      next.exitCode ?? null,
      next.signal ?? null,
      next.finalMessagePath ?? null,
      next.startedAt ?? null,
      next.updatedAt,
      next.finishedAt ?? null,
      next.lastError ?? null,
      cliRunId,
    );
    return next;
  }

  listActiveCliRuns(taskId: string): CodexCliRun[] {
    return this.database.db
      .prepare<unknown[], CodexCliRunRow>("select * from codex_cli_runs where task_id = ? and status in ('starting', 'streaming') order by updated_at asc")
      .all(taskId)
      .map(mapRun);
  }

  countActiveCliRuns(): number {
    const row = this.database.db
      .prepare<unknown[], { count: number }>("select count(*) as count from codex_cli_runs where status in ('starting', 'streaming')")
      .get();
    return row?.count ?? 0;
  }

  listActiveCliRunTaskIds(): string[] {
    return this.database.db
      .prepare<unknown[], { task_id: string }>("select distinct task_id from codex_cli_runs where status in ('starting', 'streaming')")
      .all()
      .map((row) => row.task_id);
  }

  getLatestCliRunForSubtask(subtaskId: string): CodexCliRun | undefined {
    const row = this.database.db
      .prepare<unknown[], CodexCliRunRow>("select * from codex_cli_runs where subtask_id = ? order by updated_at desc limit 1")
      .get(subtaskId);
    return row ? mapRun(row) : undefined;
  }

  addCliEvent(input: { cliRunId: string; eventIndex: number; eventType?: string; eventJson: string }): void {
    this.database.db.prepare(`insert into codex_cli_events (
      event_id, cli_run_id, event_index, event_type, event_json, created_at
    ) values (?, ?, ?, ?, ?, ?)`).run(
      createId(),
      input.cliRunId,
      input.eventIndex,
      input.eventType ?? null,
      input.eventJson,
      this.clock.now(),
    );
  }

  listCliEvents(cliRunId: string, limit = 30): Array<{ eventIndex: number; eventType?: string; eventJson: string }> {
    return this.database.db
      .prepare<unknown[], { event_index: number; event_type: string | null; event_json: string }>(
        "select event_index, event_type, event_json from codex_cli_events where cli_run_id = ? order by event_index desc limit ?",
      )
      .all(cliRunId, Math.max(1, Math.min(limit, 200)))
      .reverse()
      .map((row) => ({ eventIndex: row.event_index, ...(row.event_type ? { eventType: row.event_type } : {}), eventJson: row.event_json }));
  }

  createApproval(input: { taskId: string; requestedBy?: string; requestJson: string; expiresAt?: number }): ProjectApproval {
    const now = this.clock.now();
    const approval: ProjectApproval = {
      approvalId: createId(),
      taskId: input.taskId,
      kind: "start_project",
      status: "pending",
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      requestJson: input.requestJson,
      createdAt: now,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    };
    this.database.db.prepare(`insert into project_approvals (
      approval_id, task_id, kind, status, requested_by, request_json, created_at, expires_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      approval.approvalId,
      approval.taskId,
      approval.kind,
      approval.status,
      approval.requestedBy ?? null,
      approval.requestJson,
      approval.createdAt,
      approval.expiresAt ?? null,
    );
    return approval;
  }

  getApproval(approvalId: string): ProjectApproval | undefined {
    const row = this.database.db
      .prepare<unknown[], ProjectApprovalRow>("select * from project_approvals where approval_id = ?")
      .get(approvalId);
    return row ? mapApproval(row) : undefined;
  }

  decideApproval(approvalId: string, params: { status: "approved" | "rejected"; decidedBy?: string; note?: string }): ProjectApproval {
    const current = this.getApproval(approvalId);
    if (!current) {
      throw new Error(`Unknown approval ${approvalId}.`);
    }
    const now = this.clock.now();
    this.database.db.prepare(`update project_approvals set status=?, decided_by=?, decision_note=?, decided_at=? where approval_id=?`).run(
      params.status,
      params.decidedBy ?? null,
      params.note ?? null,
      now,
      approvalId,
    );
    return {
      ...current,
      status: params.status,
      ...(params.decidedBy ? { decidedBy: params.decidedBy } : {}),
      ...(params.note ? { decisionNote: params.note } : {}),
      decidedAt: now,
    };
  }

  projectSnapshot(taskId: string): ProjectStatusSnapshot | undefined {
    const task = this.getTask(taskId);
    if (!task) {
      return undefined;
    }
    return {
      task,
      subtasks: this.listSubtasks(taskId),
      activeRuns: this.listActiveCliRuns(taskId),
    };
  }
}
