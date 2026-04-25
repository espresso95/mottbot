import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../app/config.js";
import type { Clock } from "../shared/clock.js";
import type { CodexCliRunner } from "../codex-cli/codex-cli-runner.js";
import type { ProjectTaskStore } from "./project-task-store.js";
import type { WorktreeManager } from "../worktrees/worktree-manager.js";
import type { CodexCliRun, ProjectApproval, ProjectSubtask, ProjectTask } from "./project-types.js";

/** Callback used to publish project completion or failure summaries back to Telegram. */
export type ProjectTaskReporter = (params: { task: ProjectTask; text: string }) => void;

/** Result returned from project scheduler actions that may create approvals or change task state. */
export type ProjectTaskActionResult = {
  ok: boolean;
  message: string;
  approvalId?: string;
};

type PublishApprovalRequest = {
  openPullRequest: boolean;
  pushToBaseRef: boolean;
};

const CLEANUP_ALLOWED_STATUSES = new Set<ProjectTask["status"]>(["completed", "failed", "cancelled"]);

function parsePublishApprovalRequest(raw: string): PublishApprovalRequest {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "openPullRequest" in parsed) {
      const request = parsed as { openPullRequest?: unknown; pushToBaseRef?: unknown };
      return {
        openPullRequest: request.openPullRequest === true,
        pushToBaseRef: request.pushToBaseRef === true,
      };
    }
  } catch {
    // Malformed approval payloads fall back to the safest publish action.
  }
  return { openPullRequest: false, pushToBaseRef: false };
}

/** Polling scheduler that advances project tasks, starts worker runs, and integrates results. */
export class ProjectTaskScheduler {
  private timer?: NodeJS.Timeout;
  private readonly activeSubtasks = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly store: ProjectTaskStore,
    private readonly runner: CodexCliRunner,
    private readonly worktrees: WorktreeManager,
    private readonly reporter?: ProjectTaskReporter,
  ) {}

  start(): void {
    if (!this.config.projectTasks.enabled || this.timer) {
      return;
    }
    fs.mkdirSync(this.config.projectTasks.artifactRoot, { recursive: true });
    this.timer = setInterval(() => {
      void this.tick();
    }, 2_000);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  requestPublishApproval(params: {
    taskId: string;
    requestedBy?: string;
    openPullRequest?: boolean;
    pushToBaseRef?: boolean;
  }): ProjectTaskActionResult {
    const task = this.store.getTask(params.taskId);
    if (!task) {
      return { ok: false, message: "Unknown task id." };
    }
    if (task.status !== "completed") {
      return {
        ok: false,
        message: `Task ${task.taskId} is ${task.status}; publish is available after review completes.`,
      };
    }
    if (!task.finalBranch || !task.integrationWorktreePath) {
      return { ok: false, message: `Task ${task.taskId} does not have an integrated branch to publish.` };
    }
    if (params.openPullRequest && params.pushToBaseRef) {
      return { ok: false, message: "Choose either main or pr for publish, not both." };
    }
    const approval = this.store.createApproval({
      taskId: task.taskId,
      kind: "push",
      requestedBy: params.requestedBy,
      requestJson: JSON.stringify({
        openPullRequest: params.openPullRequest === true,
        pushToBaseRef: params.pushToBaseRef === true,
      }),
    });
    const action = params.openPullRequest
      ? "push the final branch and open a PR"
      : params.pushToBaseRef
        ? `push the verified result to ${task.baseRef}`
        : "push the final branch";
    return {
      ok: true,
      approvalId: approval.approvalId,
      message: `Created publish approval ${approval.approvalId} to ${action}. Run /project approve ${approval.approvalId}`,
    };
  }

  approveApproval(approvalId: string, decidedBy?: string): ProjectTaskActionResult {
    const approval = this.store.getApproval(approvalId);
    if (!approval) {
      return { ok: false, message: `Unknown approval ${approvalId}.` };
    }
    if (approval.status !== "pending") {
      return { ok: false, message: `Approval ${approvalId} is already ${approval.status}.` };
    }
    if (approval.kind === "start_project") {
      this.store.decideApproval(approval.approvalId, {
        status: "approved",
        decidedBy,
      });
      this.store.updateTask(approval.taskId, {
        status: "queued",
      });
      return { ok: true, message: `Approved ${approvalId}. Task ${approval.taskId} queued.` };
    }
    if (approval.kind === "push") {
      return this.approvePublish(approval, decidedBy);
    }
    return { ok: false, message: `Approval kind ${approval.kind} is not supported yet.` };
  }

  async tick(): Promise<void> {
    const tasks = this.store.listRunnableTasks(20);
    let activeWorkerCount = this.store.countActiveCliRuns();
    const activeProjectIds = new Set(this.store.listActiveCliRunTaskIds());
    for (const originalTask of tasks) {
      let task = originalTask;
      if (task.status === "queued") {
        if (!activeProjectIds.has(task.taskId) && activeProjectIds.size >= this.maxConcurrentProjects()) {
          continue;
        }
        task = this.store.updateTask(task.taskId, { status: "running", startedAt: this.clock.now() });
      }
      if (task.status === "integrating") {
        activeWorkerCount = this.handleIntegratingTask(task, activeWorkerCount, activeProjectIds);
        continue;
      }
      if (task.status === "reviewing") {
        activeWorkerCount = this.handleReviewingTask(task, activeWorkerCount, activeProjectIds);
        continue;
      }
      if (task.status !== "running") {
        continue;
      }
      const subtasks = this.store.listSubtasks(task.taskId);
      this.refreshDependencyStates(subtasks);
      const dependencyRefreshedSubtasks = this.store.listSubtasks(task.taskId);
      this.finishTerminalSubtasks(task, dependencyRefreshedSubtasks);

      let activeRunsForTask = this.store.listActiveCliRuns(task.taskId).length;
      const readySubtasks = this.store
        .listReadySubtasks(task.taskId)
        .filter((subtask) => subtask.role === "worker" && (subtask.status === "ready" || subtask.status === "queued"));
      const perProjectLimit = this.perProjectWorkerLimit(task);
      for (const subtask of readySubtasks) {
        if (activeRunsForTask >= perProjectLimit) {
          break;
        }
        if (activeWorkerCount >= this.globalWorkerLimit()) {
          break;
        }
        if (!activeProjectIds.has(task.taskId) && activeProjectIds.size >= this.maxConcurrentProjects()) {
          break;
        }
        if (this.activeSubtasks.has(subtask.subtaskId)) {
          continue;
        }
        const started = this.startSubtask(task, subtask);
        if (!started) {
          continue;
        }
        activeRunsForTask += 1;
        activeWorkerCount += 1;
        activeProjectIds.add(task.taskId);
      }

      const refreshedSubtasks = this.store.listSubtasks(task.taskId);
      const workerSubtasks = refreshedSubtasks.filter((subtask) => subtask.role === "worker");
      const completedWorkers = workerSubtasks.filter((subtask) => subtask.status === "completed");
      const failed = refreshedSubtasks.find((subtask) => subtask.status === "failed");
      if (failed) {
        this.store.updateTask(task.taskId, {
          status: "failed",
          finishedAt: this.clock.now(),
          lastError: failed.lastError ?? "A worker failed.",
        });
        continue;
      }
      if (workerSubtasks.length > 0 && completedWorkers.length === workerSubtasks.length) {
        this.beginIntegration(task, completedWorkers);
      }
    }
  }

  private perProjectWorkerLimit(task: ProjectTask): number {
    const hardLimit = this.config.projectTasks.hardMaxParallelWorkersPerProject ?? task.maxParallelWorkers;
    return Math.max(1, Math.min(task.maxParallelWorkers, hardLimit));
  }

  private maxConcurrentProjects(): number {
    return Math.max(1, this.config.projectTasks.maxConcurrentProjects ?? 1);
  }

  private globalWorkerLimit(): number {
    return Math.max(1, this.config.projectTasks.maxConcurrentCodexWorkersGlobal ?? 1);
  }

  private handleIntegratingTask(task: ProjectTask, activeWorkerCount: number, activeProjectIds: Set<string>): number {
    this.finishTerminalSubtasks(task, this.store.listSubtasks(task.taskId));
    const subtasks = this.store.listSubtasks(task.taskId);
    const failedIntegrator = subtasks.find(
      (subtask) => subtask.role === "integrator" && (subtask.status === "failed" || subtask.status === "cancelled"),
    );
    if (failedIntegrator) {
      this.store.updateTask(task.taskId, {
        status: failedIntegrator.status === "cancelled" ? "cancelled" : "failed",
        finishedAt: this.clock.now(),
        lastError: failedIntegrator.lastError ?? "Integration worker failed.",
      });
      return activeWorkerCount;
    }

    const activeRunsForTask = this.store.listActiveCliRuns(task.taskId).length;
    const completedIntegrator = subtasks.find(
      (subtask) => subtask.role === "integrator" && subtask.status === "completed",
    );
    if (completedIntegrator && activeRunsForTask === 0) {
      this.beginReview(task, subtasks);
      return activeWorkerCount;
    }

    const nextIntegrator = subtasks.find(
      (subtask) => subtask.role === "integrator" && (subtask.status === "ready" || subtask.status === "queued"),
    );
    if (!nextIntegrator || activeRunsForTask > 0) {
      return activeWorkerCount;
    }
    if (activeWorkerCount >= this.globalWorkerLimit()) {
      return activeWorkerCount;
    }
    if (!activeProjectIds.has(task.taskId) && activeProjectIds.size >= this.maxConcurrentProjects()) {
      return activeWorkerCount;
    }
    if (this.startSubtask(task, nextIntegrator)) {
      activeProjectIds.add(task.taskId);
      return activeWorkerCount + 1;
    }
    return activeWorkerCount;
  }

  private beginIntegration(task: ProjectTask, completedWorkers: ProjectSubtask[]): void {
    let prepared: { worktreePath: string; branchName: string };
    try {
      prepared = this.worktrees.prepareIntegration({
        taskId: task.taskId,
        repoRoot: task.repoRoot,
        baseRef: task.baseRef,
      });
    } catch (error) {
      this.store.updateTask(task.taskId, {
        status: "failed",
        finishedAt: this.clock.now(),
        lastError: error instanceof Error ? error.message : "Failed to prepare integration worktree.",
      });
      return;
    }

    const integrationTask = this.store.updateTask(task.taskId, {
      status: "integrating",
      integrationBranch: prepared.branchName,
      integrationWorktreePath: prepared.worktreePath,
    });
    for (const worker of completedWorkers) {
      if (!worker.branchName) {
        continue;
      }
      const merge = this.worktrees.mergeBranch({
        worktreePath: prepared.worktreePath,
        branchName: worker.branchName,
      });
      if (!merge.ok) {
        this.queueConflictResolver({
          task: integrationTask,
          workers: completedWorkers,
          conflictBranch: worker.branchName,
          mergeOutput: merge.output,
        });
        return;
      }
    }
    this.beginReview(integrationTask, completedWorkers);
  }

  private handleReviewingTask(task: ProjectTask, activeWorkerCount: number, activeProjectIds: Set<string>): number {
    this.finishTerminalSubtasks(task, this.store.listSubtasks(task.taskId));
    const subtasks = this.store.listSubtasks(task.taskId);
    const failedReviewer = subtasks.find(
      (subtask) => subtask.role === "reviewer" && (subtask.status === "failed" || subtask.status === "cancelled"),
    );
    if (failedReviewer) {
      this.store.updateTask(task.taskId, {
        status: failedReviewer.status === "cancelled" ? "cancelled" : "failed",
        finishedAt: this.clock.now(),
        lastError: failedReviewer.lastError ?? "Review worker failed.",
      });
      return activeWorkerCount;
    }

    const activeRunsForTask = this.store.listActiveCliRuns(task.taskId).length;
    const completedReviewer = subtasks.find((subtask) => subtask.role === "reviewer" && subtask.status === "completed");
    if (completedReviewer && activeRunsForTask === 0) {
      this.completeReviewedTask(task, subtasks, completedReviewer);
      return activeWorkerCount;
    }

    const nextReviewer = subtasks.find(
      (subtask) => subtask.role === "reviewer" && (subtask.status === "ready" || subtask.status === "queued"),
    );
    if (!nextReviewer || activeRunsForTask > 0) {
      return activeWorkerCount;
    }
    if (activeWorkerCount >= this.globalWorkerLimit()) {
      return activeWorkerCount;
    }
    if (!activeProjectIds.has(task.taskId) && activeProjectIds.size >= this.maxConcurrentProjects()) {
      return activeWorkerCount;
    }
    if (this.startSubtask(task, nextReviewer)) {
      activeProjectIds.add(task.taskId);
      return activeWorkerCount + 1;
    }
    return activeWorkerCount;
  }

  private queueConflictResolver(params: {
    task: ProjectTask;
    workers: ProjectSubtask[];
    conflictBranch: string;
    mergeOutput: string;
  }): void {
    const prompt = [
      "Resolve the integration merge conflict for this Mottbot project task.",
      `Project task: ${params.task.taskId}`,
      `Integration branch: ${params.task.integrationBranch ?? "unknown"}`,
      `Conflicting worker branch: ${params.conflictBranch}`,
      "",
      "You are already in the integration worktree. Resolve conflicts, keep the completed worker changes, run relevant checks if practical, and finish the merge commit.",
      "",
      "Merge output:",
      params.mergeOutput.slice(0, 4_000) || "No merge output captured.",
    ].join("\n");
    const integrator = this.store.createSubtask({
      taskId: params.task.taskId,
      title: "Resolve integration conflicts",
      role: "integrator",
      prompt,
      dependsOnSubtaskIds: params.workers.map((worker) => worker.subtaskId),
      status: "ready",
    });
    this.store.updateSubtask(integrator.subtaskId, {
      branchName: params.task.integrationBranch,
      worktreePath: params.task.integrationWorktreePath,
    });
    this.store.updateTask(params.task.taskId, {
      status: "integrating",
      lastError: `Integration conflict while merging ${params.conflictBranch}; queued ${integrator.subtaskId}.`,
    });
  }

  private beginReview(task: ProjectTask, subtasks: ProjectSubtask[]): void {
    if (!task.integrationWorktreePath || !task.integrationBranch) {
      this.store.updateTask(task.taskId, {
        status: "failed",
        finishedAt: this.clock.now(),
        lastError: "Integrated task is missing its integration worktree or branch.",
      });
      return;
    }
    const existingReviewer = subtasks.find((subtask) => subtask.role === "reviewer");
    const finalDiffStat = this.worktrees
      .diffStat({
        worktreePath: task.integrationWorktreePath,
        baseRef: task.baseRef,
      })
      .slice(0, 4_000);
    const updatedTask = this.store.updateTask(task.taskId, {
      status: "reviewing",
      ...(finalDiffStat ? { finalDiffStat } : {}),
    });
    if (existingReviewer) {
      return;
    }
    const workerSubtasks = subtasks.filter((subtask) => subtask.role === "worker");
    const workerSummaries = workerSubtasks
      .map((subtask) => `- ${subtask.title}: ${subtask.resultSummary ?? "completed"}`)
      .join("\n");
    const prompt = [
      "Review the integrated result for this Mottbot project task.",
      `Project task: ${updatedTask.taskId}`,
      `Original request: ${updatedTask.originalPrompt}`,
      `Integration branch: ${updatedTask.integrationBranch}`,
      "",
      "You are already in the integration worktree. Inspect the final diff, run lightweight checks if practical, and report whether the result is ready for operator review.",
      "",
      "Worker summaries:",
      workerSummaries || "- none",
      "",
      "Diff stat:",
      finalDiffStat || "No diff stat captured.",
    ].join("\n");
    const reviewer = this.store.createSubtask({
      taskId: updatedTask.taskId,
      title: "Review integrated result",
      role: "reviewer",
      prompt,
      dependsOnSubtaskIds: workerSubtasks.map((worker) => worker.subtaskId),
      status: "ready",
    });
    this.store.updateSubtask(reviewer.subtaskId, {
      branchName: updatedTask.integrationBranch,
      worktreePath: updatedTask.integrationWorktreePath,
    });
  }

  private completeReviewedTask(task: ProjectTask, subtasks: ProjectSubtask[], reviewer: ProjectSubtask): void {
    const workerSubtasks = subtasks.filter((subtask) => subtask.role === "worker");
    const workerSummaries = workerSubtasks
      .map((subtask) => `- ${subtask.title}: ${subtask.resultSummary ?? "completed"}`)
      .join("\n");
    const reviewSummary = reviewer.resultSummary?.trim();
    const completedTask = this.store.updateTask(task.taskId, {
      status: "completed",
      finishedAt: this.clock.now(),
      finalBranch: task.integrationBranch,
      finalSummary: [
        "Worker summaries:",
        workerSummaries || "- none",
        "",
        "Review:",
        reviewSummary || "Review completed.",
        "",
        task.integrationBranch ? `Integrated branch: ${task.integrationBranch}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    for (const subtask of workerSubtasks) {
      if (!subtask.worktreePath && !subtask.branchName) {
        continue;
      }
      this.worktrees.cleanupSubtask({
        repoRoot: task.repoRoot,
        worktreePath: subtask.worktreePath,
        branchName: subtask.branchName,
      });
    }
    this.reportCompletion(completedTask, reviewSummary);
  }

  private reportCompletion(task: ProjectTask, reviewSummary: string | undefined): void {
    if (!this.reporter) {
      return;
    }
    const text = [
      `Project completed: ${task.title}`,
      `Task ID: ${task.taskId}`,
      task.finalBranch ? `Branch: ${task.finalBranch}` : undefined,
      "",
      reviewSummary ? `Review: ${reviewSummary}` : task.finalSummary,
      task.finalBranch ? `Publish: /project publish ${task.taskId} [main|pr]` : undefined,
      task.integrationWorktreePath ? `Cleanup: /project cleanup ${task.taskId}` : undefined,
    ]
      .filter((line): line is string => typeof line === "string" && line.length > 0)
      .join("\n")
      .slice(0, 3_900);
    try {
      this.reporter({ task, text });
    } catch {
      // Reporting must not change durable project outcome.
    }
  }

  private approvePublish(approval: ProjectApproval, decidedBy?: string): ProjectTaskActionResult {
    const task = this.store.getTask(approval.taskId);
    if (!task) {
      return { ok: false, message: `Task ${approval.taskId} no longer exists.` };
    }
    if (task.status !== "completed") {
      return { ok: false, message: `Task ${task.taskId} is ${task.status}; publish is available after completion.` };
    }
    if (!task.finalBranch || !task.integrationWorktreePath) {
      return { ok: false, message: `Task ${task.taskId} does not have an integrated branch to publish.` };
    }
    const request = parsePublishApprovalRequest(approval.requestJson);
    this.store.decideApproval(approval.approvalId, {
      status: "approved",
      decidedBy,
    });
    try {
      const targetRef = request.pushToBaseRef ? task.baseRef : task.finalBranch;
      const result = this.worktrees.publishBranch({
        repoRoot: task.repoRoot,
        worktreePath: task.integrationWorktreePath,
        branchName: task.finalBranch,
        baseRef: task.baseRef,
        targetRef,
        openPullRequest: request.openPullRequest,
        title: task.title,
        body: [`Project task: ${task.taskId}`, "", task.finalSummary ?? "Project Mode completed review."].join("\n"),
      });
      const pushedBranchLine = request.pushToBaseRef
        ? `Pushed branch: ${task.finalBranch} -> ${task.baseRef}`
        : `Pushed branch: ${task.finalBranch}`;
      const publishSummary = [
        pushedBranchLine,
        result.pullRequestUrl ? `Pull request: ${result.pullRequestUrl}` : undefined,
        !result.pullRequestUrl && result.pullRequestOutput
          ? `Pull request output: ${result.pullRequestOutput}`
          : undefined,
      ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");
      this.store.updateTask(task.taskId, {
        finalSummary: [task.finalSummary, "", "Publish:", publishSummary].filter(Boolean).join("\n"),
        lastError: undefined,
      });
      return {
        ok: true,
        message: [`Published ${task.taskId}.`, publishSummary].filter(Boolean).join("\n"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Publish failed.";
      this.store.updateTask(task.taskId, {
        lastError: `Publish failed: ${message}`,
      });
      return { ok: false, message: `Publish failed for ${task.taskId}: ${message}` };
    }
  }

  private finishTerminalSubtasks(task: ProjectTask, subtasks: ProjectSubtask[]): void {
    const runningSubtasks = subtasks.filter((subtask) => subtask.status === "running");
    const activeRunsForTask = this.store.listActiveCliRuns(task.taskId).length;
    for (const subtask of runningSubtasks) {
      const latestRun = this.store.getLatestCliRunForSubtask(subtask.subtaskId);
      if (latestRun?.status === "starting" || latestRun?.status === "streaming") {
        continue;
      }
      if (!latestRun && activeRunsForTask > 0) {
        continue;
      }
      this.finishSubtask(task, subtask, latestRun);
    }
  }

  private finishSubtask(task: ProjectTask, subtask: ProjectSubtask, latestRun: CodexCliRun | undefined): void {
    const finalSummary = this.readFinalSummary(task.taskId, subtask.subtaskId);
    const protectedChanges = subtask.worktreePath ? this.worktrees.listProtectedChanges(subtask.worktreePath) : [];
    const protectedPathError =
      protectedChanges.length > 0 ? `Protected paths modified: ${protectedChanges.slice(0, 8).join(", ")}` : undefined;
    const runFailed =
      latestRun?.status === "failed" || latestRun?.status === "timed_out" || latestRun?.status === "cancelled";
    const lastError =
      protectedPathError ??
      latestRun?.lastError ??
      (finalSummary.failed ? finalSummary.text : undefined) ??
      (runFailed ? "Worker failed" : undefined);
    const nextStatus =
      latestRun?.status === "cancelled"
        ? "cancelled"
        : runFailed || finalSummary.failed || !!protectedPathError
          ? "failed"
          : "completed";
    this.store.updateSubtask(subtask.subtaskId, {
      status: nextStatus,
      finishedAt: this.clock.now(),
      ...(finalSummary.text ? { resultSummary: finalSummary.text } : {}),
      ...(lastError ? { lastError } : {}),
    });
    const keepIntegrationWorktree = subtask.role === "integrator" || subtask.role === "reviewer";
    if ((subtask.worktreePath || subtask.branchName) && !keepIntegrationWorktree) {
      this.worktrees.cleanupSubtask({
        repoRoot: task.repoRoot,
        worktreePath: subtask.worktreePath,
        branchName: subtask.branchName,
        deleteBranch: nextStatus !== "completed",
      });
    }
    this.activeSubtasks.delete(subtask.subtaskId);
  }

  private startSubtask(task: ProjectTask, subtask: ProjectSubtask): boolean {
    let prepared: { worktreePath: string; branchName: string } | undefined;
    const usesExistingWorktree =
      (subtask.role === "integrator" || subtask.role === "reviewer") &&
      typeof subtask.worktreePath === "string" &&
      typeof subtask.branchName === "string";
    try {
      prepared = usesExistingWorktree
        ? { worktreePath: subtask.worktreePath!, branchName: subtask.branchName! }
        : this.worktrees.prepareSubtask({
            taskId: task.taskId,
            subtaskId: subtask.subtaskId,
            repoRoot: task.repoRoot,
            baseRef: task.baseRef,
          });
      this.store.updateSubtask(subtask.subtaskId, {
        status: "running",
        startedAt: this.clock.now(),
        attempt: subtask.attempt + 1,
        branchName: prepared.branchName,
        worktreePath: prepared.worktreePath,
      });
      this.activeSubtasks.add(subtask.subtaskId);
      this.runner.start({
        taskId: task.taskId,
        subtaskId: subtask.subtaskId,
        cwd: prepared.worktreePath,
        prompt: subtask.prompt,
        profile: this.profileForSubtask(subtask),
      });
      return true;
    } catch (error) {
      this.activeSubtasks.delete(subtask.subtaskId);
      if (prepared && !usesExistingWorktree) {
        this.worktrees.cleanupSubtask({
          repoRoot: task.repoRoot,
          worktreePath: prepared.worktreePath,
          branchName: prepared.branchName,
        });
      }
      this.store.updateSubtask(subtask.subtaskId, {
        status: "failed",
        finishedAt: this.clock.now(),
        lastError: error instanceof Error ? error.message : "Failed to start worker.",
      });
      return false;
    }
  }

  private profileForSubtask(subtask: ProjectSubtask): string | undefined {
    return subtask.role === "reviewer" ? this.config.projectTasks.codex.reviewerProfile : undefined;
  }

  private refreshDependencyStates(subtasks: ReturnType<ProjectTaskStore["listSubtasks"]>): void {
    const byId = new Map(subtasks.map((subtask) => [subtask.subtaskId, subtask]));
    for (const subtask of subtasks) {
      if (
        subtask.status === "completed" ||
        subtask.status === "running" ||
        subtask.status === "failed" ||
        subtask.status === "cancelled" ||
        subtask.status === "skipped"
      ) {
        continue;
      }
      if (subtask.dependsOnSubtaskIds.length === 0) {
        if (subtask.status === "blocked") {
          this.store.updateSubtask(subtask.subtaskId, { status: "ready" });
        }
        continue;
      }
      const dependencyStates = subtask.dependsOnSubtaskIds.map((dependencyId) => byId.get(dependencyId)?.status);
      if (
        dependencyStates.some(
          (status) => status === "failed" || status === "cancelled" || status === "skipped" || status === undefined,
        )
      ) {
        this.store.updateSubtask(subtask.subtaskId, {
          status: "skipped",
          finishedAt: this.clock.now(),
          lastError: "Skipped because one or more dependencies did not complete successfully.",
        });
        continue;
      }
      if (dependencyStates.every((status) => status === "completed") && subtask.status === "blocked") {
        this.store.updateSubtask(subtask.subtaskId, { status: "ready" });
      }
    }
  }

  cancelTask(taskId: string): { cancelled: boolean; message: string } {
    const task = this.store.getTask(taskId);
    if (!task) {
      return { cancelled: false, message: "Unknown task id." };
    }
    const subtasks = this.store.listSubtasks(taskId);
    for (const subtask of subtasks) {
      if (subtask.status === "running") {
        this.runner.cancelSubtask(subtask.subtaskId);
      }
      if (subtask.status === "queued" || subtask.status === "ready" || subtask.status === "running") {
        this.store.updateSubtask(subtask.subtaskId, {
          status: "cancelled",
          finishedAt: this.clock.now(),
        });
      }
      if (subtask.worktreePath || subtask.branchName) {
        this.worktrees.cleanupSubtask({
          repoRoot: task.repoRoot,
          worktreePath: subtask.worktreePath,
          branchName: subtask.branchName,
        });
      }
      this.activeSubtasks.delete(subtask.subtaskId);
    }
    this.store.updateTask(taskId, {
      status: "cancelled",
      finishedAt: this.clock.now(),
    });
    return { cancelled: true, message: `Cancelled ${taskId}.` };
  }

  /** Removes retained local worktrees and branches for a finished project task. */
  cleanupTask(taskId: string): ProjectTaskActionResult {
    const task = this.store.getTask(taskId);
    if (!task) {
      return { ok: false, message: "Unknown task id." };
    }
    if (!CLEANUP_ALLOWED_STATUSES.has(task.status)) {
      return {
        ok: false,
        message: `Task ${task.taskId} is ${task.status}; cleanup is available after completion, failure, or cancellation.`,
      };
    }
    if (this.store.listActiveCliRuns(task.taskId).length > 0) {
      return { ok: false, message: `Task ${task.taskId} still has active Codex runs; cancel it before cleanup.` };
    }

    const subtasks = this.store.listSubtasks(task.taskId);
    const targets = new Map<string, { worktreePath?: string; branchName?: string }>();
    const addTarget = (worktreePath?: string, branchName?: string) => {
      if (!worktreePath && !branchName) {
        return;
      }
      targets.set(`${worktreePath ?? ""}\0${branchName ?? ""}`, { worktreePath, branchName });
    };

    addTarget(task.integrationWorktreePath, task.integrationBranch);
    for (const subtask of subtasks) {
      addTarget(subtask.worktreePath, subtask.branchName);
    }

    if (targets.size === 0) {
      return { ok: true, message: `No retained project worktrees or local branches found for ${task.taskId}.` };
    }

    for (const target of targets.values()) {
      this.worktrees.cleanupSubtask({
        repoRoot: task.repoRoot,
        worktreePath: target.worktreePath,
        branchName: target.branchName,
      });
    }
    for (const subtask of subtasks) {
      if (!subtask.worktreePath && !subtask.branchName) {
        continue;
      }
      this.store.updateSubtask(subtask.subtaskId, {
        worktreePath: undefined,
        branchName: undefined,
      });
    }

    const cleanupSummary = [
      `Removed retained project worktrees and local branches for ${task.taskId}.`,
      task.finalBranch ? `Final branch reference: ${task.finalBranch}` : undefined,
    ]
      .filter((line): line is string => typeof line === "string")
      .join("\n");
    this.store.updateTask(task.taskId, {
      integrationBranch: undefined,
      integrationWorktreePath: undefined,
      finalSummary: [task.finalSummary, "", "Cleanup:", cleanupSummary].filter(Boolean).join("\n"),
      lastError: undefined,
    });
    return {
      ok: true,
      message: [`Cleaned ${task.taskId}.`, cleanupSummary].join("\n"),
    };
  }

  private readFinalSummary(taskId: string, subtaskId: string): { text?: string; failed: boolean } {
    const outputPath = path.join(this.config.projectTasks.artifactRoot, taskId, subtaskId, "final.md");
    if (!fs.existsSync(outputPath)) {
      return { failed: false };
    }
    const raw = fs.readFileSync(outputPath, "utf8").trim();
    if (!raw) {
      return { failed: false };
    }
    return { text: raw.slice(0, 4_000), failed: /\b(error|failed|failure)\b/i.test(raw) };
  }
}
