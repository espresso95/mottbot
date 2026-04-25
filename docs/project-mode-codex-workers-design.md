# Project Mode Design: Long-Running Codex CLI Workflows with Parallel Git Worktrees

This document captures an implementation-ready design for extending MottBot with a durable **Project Mode** that supervises long-running coding tasks using non-interactive Codex CLI workers in isolated Git worktrees.

## Summary

Project Mode introduces a scheduler-driven path alongside normal chat runs:

- **MottBot** remains the planner, policy engine, scheduler, and reporter.
- **Codex CLI** becomes a bounded worker process.
- **Git worktrees** provide per-subtask isolation.
- **SQLite** stores durable project/subtask/run/event/approval state.
- **Telegram commands** provide user control for start/status/tail/approval/cancel.

The first implementation target is a minimal single-worker flow, then phased expansion to planning graphs, parallel workers, integration, and review.

## Goals and non-goals

### Primary goals

- Start long-running coding projects from Telegram.
- Run Codex CLI in machine-readable JSON mode.
- Persist all task/subtask/run/event state for restart recovery.
- Add bounded parallelism via per-worker branches and worktrees.
- Maintain approval gates for destructive or high-impact actions.

### Non-goals (v1)

- No distributed worker fleet.
- No arbitrary shell passthrough for model-generated commands.
- No automatic push/deploy without explicit approvals.
- No direct multi-agent edits in the primary checkout.

## Architectural shape

Normal runtime stays intact:

```text
Telegram → SessionQueue → RunOrchestrator → CodexTransport → TelegramOutbox
```

Project Mode adds a sibling path:

```text
Telegram → ProjectCommandRouter → ProjectTaskScheduler → CodexCliRunner → CodexCliService
```

High-level Project Mode internals:

```text
ProjectTaskScheduler
  ├── ProjectPlanner
  ├── WorktreeManager
  ├── CodexCliRunner
  ├── CodexJsonlEventParser
  ├── ProjectIntegrator
  ├── ProjectReviewer
  └── ProjectOutboxReporter
```

## Proposed module layout

```text
src/project-tasks/
  project-command-router.ts
  project-task-store.ts
  project-task-scheduler.ts
  project-planner.ts
  project-integrator.ts
  project-reviewer.ts
  project-outbox-reporter.ts
  project-types.ts

src/codex-cli/
  codex-cli-runner.ts
  codex-jsonl-parser.ts
  codex-cli-event-store.ts
  codex-cli-session-store.ts
  codex-cli-types.ts

src/worktrees/
  worktree-manager.ts
  git-runner.ts
  git-types.ts
```

## Data model additions

Add project-oriented tables and indexes for:

- `project_tasks`
- `project_subtasks`
- `project_worktrees`
- `codex_cli_runs`
- `codex_cli_events`
- `project_approvals`
- `project_usage_events`

State columns should enforce explicit check constraints for task/subtask/run status transitions.

## State machines

- Project states: `draft → awaiting_approval → planning → queued → running → integrating → reviewing → completed` (+ paused/failed/cancelled paths).
- Subtask states: `queued/blocked/ready/running/completed` (+ failed/cancelled/skipped paths).
- CLI run states: `starting/streaming/exited` (+ failed/timed_out/cancelled paths).

Scheduler responsibilities:

- resolve dependencies
- enforce global/per-project concurrency caps
- launch ready subtasks
- reconcile completions/failures/retries
- trigger integration and final review

## Codex CLI execution model

Codex workers should run non-interactively in JSONL/event mode. Representative command shape:

```bash
codex exec \
  --cd "$WORKTREE_PATH" \
  --json \
  --profile mottbot-coder \
  --output-last-message "$RUN_DIR/final.md" \
  "$PROMPT"
```

Design requirements:

- parse and persist JSONL events (`codex_cli_events`)
- stream bounded stdout/stderr to artifact logs
- track pid/exit/signal and timeout outcomes
- support cancellation and restart reconciliation

The reusable `CodexCliService` owns the actual process spawning, artifact paths, stdout/stderr logs, JSONL parsing, and cancellation. Project Mode uses it through `CodexCliRunner`, which adapts those callbacks into durable SQLite `codex_cli_runs` and `codex_cli_events` rows. The same service also backs the direct `mottbot_codex_job_*` tool handlers for approved, process-local Codex jobs.

## Worktree and branch strategy

Each worker gets a unique worktree and branch:

- branch format: `mottbot/{taskSlug}/{subtaskSlug}`
- one Codex worker per worktree
- integration occurs in a separate integration worktree/branch
- worker branches merge/cherry-pick into integration branch in dependency order

Safety constraints:

- normalize and validate all paths against configured roots
- deny edits to protected paths (e.g., `.git`, auth artifacts, db/log/output dirs)
- require approval before branch deletion, pushes, deploys, or destructive Git actions

## Telegram UX surface

Minimal v1 commands:

- `/project start <repo> <task>`
- `/project status [task_id]`
- `/project tail <subtask_id>`
- `/project cancel <task_id>`
- `/project approve <approval_id>`

Planned expansions:

- `/project workers`, `/project diff`, `/project pause`, `/project resume`
- `/project integrate`, `/project cleanup`, `/project usage`

## Config additions

Add `projectTasks` configuration with:

- enable flag
- repo roots + worktree/artifact roots
- concurrency limits
- default base ref
- codex profile/timeout/output caps
- approval requirements
- protected branch and push/PR policies

## Recovery and observability

On startup:

- reload active project and CLI run records
- verify process liveness via pid checks
- reconcile stale runs/worktrees
- retry eligible subtasks or surface failures

Operational visibility:

- `/project status` and `/project workers`
- structured logs for scheduling/run/integration lifecycle events
- health snapshot counters for project runtime

## Phased implementation plan

1. **Phase 1:** single-worker project runner + status/tail/cancel + durable run events.
2. **Phase 2:** worktree manager + path protections + cleanup.
3. **Phase 3:** planner output + subtask graph + dependency gating.
4. **Phase 4:** parallel worker scheduling with concurrency limits.
5. **Phase 5:** integration branch workflow + conflict handling worker.
6. **Phase 6:** reviewer stage + final Telegram report + optional PR/push approvals.

## Implementation rule

Do not automate interactive terminal sessions. Build Project Mode as:

```text
Durable scheduler → isolated worktrees → non-interactive Codex JSONL workers → deterministic integration/review → Telegram controls
```

That structure preserves MottBot’s host-local safety posture while enabling long-running and parallel coding workflows.
