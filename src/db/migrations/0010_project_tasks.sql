create table if not exists project_tasks (
  task_id text primary key,
  chat_id text not null,
  requested_by_user_id text,
  requested_by_username text,
  repo_root text not null,
  base_ref text not null,
  integration_branch text,
  integration_worktree_path text,
  title text not null,
  original_prompt text not null,
  plan_json text,
  status text not null check (
    status in (
      'draft',
      'awaiting_approval',
      'planning',
      'queued',
      'running',
      'paused',
      'integrating',
      'reviewing',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  priority integer not null default 0,
  max_parallel_workers integer not null default 2,
  max_attempts_per_subtask integer not null default 2,
  created_at integer not null,
  updated_at integer not null,
  started_at integer,
  finished_at integer,
  last_error text,
  final_summary text,
  final_branch text,
  final_diff_stat text
);

create table if not exists project_subtasks (
  subtask_id text primary key,
  task_id text not null references project_tasks(task_id) on delete cascade,
  title text not null,
  role text not null check (role in ('planner', 'worker', 'integrator', 'reviewer')),
  prompt text not null,
  scope_json text,
  depends_on_json text not null default '[]',
  status text not null check (
    status in ('queued', 'blocked', 'ready', 'running', 'completed', 'failed', 'cancelled', 'skipped')
  ),
  branch_name text,
  worktree_path text,
  codex_session_id text,
  attempt integer not null default 0,
  created_at integer not null,
  updated_at integer not null,
  started_at integer,
  finished_at integer,
  result_summary text,
  files_changed_json text,
  tests_run_json text,
  known_issues text,
  last_error text
);

create table if not exists codex_cli_runs (
  cli_run_id text primary key,
  task_id text not null references project_tasks(task_id) on delete cascade,
  subtask_id text references project_subtasks(subtask_id) on delete cascade,
  pid integer,
  command_json text not null,
  cwd text not null,
  status text not null check (
    status in ('starting', 'streaming', 'exited', 'failed', 'cancelled', 'timed_out')
  ),
  codex_thread_id text,
  codex_session_id text,
  exit_code integer,
  signal text,
  stdout_log_path text not null,
  stderr_log_path text not null,
  jsonl_log_path text not null,
  final_message_path text,
  started_at integer,
  updated_at integer not null,
  finished_at integer,
  last_error text
);

create table if not exists codex_cli_events (
  event_id text primary key,
  cli_run_id text not null references codex_cli_runs(cli_run_id) on delete cascade,
  event_index integer not null,
  event_type text,
  event_json text not null,
  created_at integer not null,
  unique(cli_run_id, event_index)
);

create table if not exists project_approvals (
  approval_id text primary key,
  task_id text not null references project_tasks(task_id) on delete cascade,
  subtask_id text references project_subtasks(subtask_id) on delete cascade,
  kind text not null check (
    kind in ('start_project', 'start_worker', 'merge', 'push', 'deploy', 'destructive_git', 'dangerous_sandbox')
  ),
  status text not null check (status in ('pending', 'approved', 'rejected', 'expired')),
  requested_by text,
  decided_by text,
  request_json text not null,
  decision_note text,
  created_at integer not null,
  decided_at integer,
  expires_at integer
);

create index if not exists idx_project_tasks_status on project_tasks(status, updated_at);
create index if not exists idx_project_subtasks_task_status on project_subtasks(task_id, status, updated_at);
create index if not exists idx_codex_cli_runs_status on codex_cli_runs(status, updated_at);
create index if not exists idx_codex_cli_events_run_index on codex_cli_events(cli_run_id, event_index);
