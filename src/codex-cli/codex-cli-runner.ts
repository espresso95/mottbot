import { CodexCliService, type CodexCliServiceConfig } from "./codex-cli-service.js";
import type { Clock } from "../shared/clock.js";
import { createId } from "../shared/ids.js";
import type { ProjectTaskStore } from "../project-tasks/project-task-store.js";

/** Runtime settings for project-mode Codex CLI worker processes and their artifacts. */
type CodexCliRunnerConfig = CodexCliServiceConfig;

/** Starts, tracks, logs, and cancels Codex CLI subprocesses for project subtasks. */
export class CodexCliRunner {
  private readonly service: CodexCliService;
  private readonly activeSubtasks = new Map<string, string>();

  constructor(
    private readonly store: ProjectTaskStore,
    clock: Clock,
    config: CodexCliRunnerConfig,
  ) {
    this.service = new CodexCliService(clock, config);
  }

  start(params: { taskId: string; subtaskId: string; cwd: string; prompt: string; profile?: string }): string {
    const job = this.service.prepare({
      jobId: createId(),
      cwd: params.cwd,
      prompt: params.prompt,
      artifactSegments: [params.taskId, params.subtaskId],
      profile: params.profile,
    });
    const run = this.store.createCliRun({
      cliRunId: job.jobId,
      taskId: params.taskId,
      subtaskId: params.subtaskId,
      commandJson: job.commandJson,
      cwd: job.cwd,
      stdoutLogPath: job.stdoutLogPath,
      stderrLogPath: job.stderrLogPath,
      jsonlLogPath: job.jsonlLogPath,
      finalMessagePath: job.finalMessagePath,
    });
    this.activeSubtasks.set(params.subtaskId, run.cliRunId);
    this.service.start(job, {
      onStreaming: ({ pid, startedAt }) => {
        this.store.updateCliRun(run.cliRunId, {
          status: "streaming",
          ...(pid !== undefined ? { pid } : {}),
          startedAt,
        });
      },
      onEvent: ({ eventIndex, eventType, eventJson }) => {
        this.store.addCliEvent({
          cliRunId: run.cliRunId,
          eventIndex,
          eventType,
          eventJson,
        });
      },
      onFinished: (patch) => {
        this.activeSubtasks.delete(params.subtaskId);
        this.store.updateCliRun(run.cliRunId, patch);
      },
    });
    return run.cliRunId;
  }

  cancelSubtask(subtaskId: string): boolean {
    const cliRunId = this.activeSubtasks.get(subtaskId);
    if (!cliRunId) {
      return false;
    }
    return this.service.cancel(cliRunId);
  }
}
