create table if not exists schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null,
  applied_at integer not null
);

create table if not exists auth_profiles (
  profile_id text primary key,
  provider text not null,
  source text not null,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  expires_at integer,
  account_id text,
  email text,
  display_name text,
  metadata_json text,
  created_at integer not null,
  updated_at integer not null
);

create table if not exists session_routes (
  session_key text primary key,
  chat_id text not null,
  thread_id integer,
  user_id text,
  route_mode text not null,
  bound_name text,
  agent_id text not null default 'main',
  profile_id text not null,
  model_ref text not null,
  fast_mode integer not null default 0,
  system_prompt text,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_session_routes_chat on session_routes(chat_id, thread_id);

create table if not exists messages (
  id text primary key,
  session_key text not null,
  run_id text,
  role text not null,
  telegram_message_id integer,
  reply_to_telegram_message_id integer,
  content_text text,
  content_json text,
  created_at integer not null,
  foreign key (session_key) references session_routes(session_key)
);

create index if not exists idx_messages_session_created on messages(session_key, created_at);

create table if not exists runs (
  run_id text primary key,
  session_key text not null,
  agent_id text not null default 'main',
  status text not null,
  model_ref text not null,
  profile_id text not null,
  transport text,
  request_identity text,
  started_at integer,
  finished_at integer,
  error_code text,
  error_message text,
  usage_json text,
  created_at integer not null,
  updated_at integer not null,
  foreign key (session_key) references session_routes(session_key)
);

create index if not exists idx_runs_session_created on runs(session_key, created_at);
create index if not exists idx_runs_agent_status_created on runs(agent_id, status, created_at);

create table if not exists run_queue (
  run_id text primary key,
  session_key text not null,
  chat_id text not null,
  thread_id integer,
  message_id integer not null,
  reply_to_message_id integer,
  event_json text,
  state text not null,
  attempts integer not null default 0,
  claimed_at integer,
  lease_expires_at integer,
  error_message text,
  created_at integer not null,
  updated_at integer not null,
  foreign key (run_id) references runs(run_id) on delete cascade,
  foreign key (session_key) references session_routes(session_key)
);

create index if not exists idx_run_queue_state_updated on run_queue(state, updated_at);
create index if not exists idx_run_queue_session_state on run_queue(session_key, state);

create table if not exists telegram_updates (
  update_id integer primary key,
  chat_id text,
  message_id integer,
  processed_at integer not null
);

create table if not exists telegram_bot_messages (
  id text primary key,
  run_id text,
  session_key text,
  chat_id text not null,
  thread_id integer,
  telegram_message_id integer not null,
  message_kind text not null,
  created_at integer not null,
  unique(chat_id, thread_id, telegram_message_id),
  foreign key (run_id) references runs(run_id),
  foreign key (session_key) references session_routes(session_key)
);

create index if not exists idx_tg_bot_messages_lookup
  on telegram_bot_messages(chat_id, thread_id, telegram_message_id);

create table if not exists outbox_messages (
  id text primary key,
  run_id text not null,
  chat_id text not null,
  thread_id integer,
  telegram_message_id integer,
  state text not null,
  last_rendered_text text,
  last_edit_at integer,
  created_at integer not null,
  updated_at integer not null,
  foreign key (run_id) references runs(run_id)
);

create index if not exists idx_outbox_run on outbox_messages(run_id);

create table if not exists transport_state (
  session_key text primary key,
  websocket_degraded_until integer,
  last_transport text,
  updated_at integer not null
);

create table if not exists tool_approvals (
  id text primary key,
  session_key text not null,
  tool_name text not null,
  approved_by_user_id text not null,
  reason text not null,
  approved_at integer not null,
  expires_at integer not null,
  request_fingerprint text,
  preview_text text,
  consumed_at integer,
  created_at integer not null,
  updated_at integer not null,
  foreign key (session_key) references session_routes(session_key)
);

create index if not exists idx_tool_approvals_active
  on tool_approvals(session_key, tool_name, expires_at, consumed_at);

create table if not exists tool_approval_audit (
  id text primary key,
  session_key text,
  run_id text,
  tool_name text not null,
  side_effect text not null,
  allowed integer not null,
  decision_code text not null,
  requested_at integer not null,
  decided_at integer not null,
  approved_by_user_id text,
  reason text,
  request_fingerprint text,
  preview_text text,
  created_at integer not null,
  foreign key (session_key) references session_routes(session_key),
  foreign key (run_id) references runs(run_id)
);

create index if not exists idx_tool_approval_audit_session_created
  on tool_approval_audit(session_key, created_at);

create index if not exists idx_tool_approval_audit_pending
  on tool_approval_audit(session_key, tool_name, decision_code, requested_at);

create table if not exists session_memories (
  id text primary key,
  session_key text not null,
  source text not null default 'explicit',
  scope text not null default 'session',
  scope_key text not null,
  content_text text not null,
  pinned integer not null default 0,
  archived_at integer,
  source_candidate_id text,
  created_at integer not null,
  updated_at integer not null,
  foreign key (session_key) references session_routes(session_key),
  foreign key (source_candidate_id) references memory_candidates(id)
);

create index if not exists idx_session_memories_session_created
  on session_memories(session_key, created_at);

create index if not exists idx_session_memories_session_source
  on session_memories(session_key, source, updated_at);

create index if not exists idx_session_memories_scope
  on session_memories(scope, scope_key, archived_at, pinned, updated_at);

create table if not exists memory_candidates (
  id text primary key,
  session_key text not null,
  scope text not null,
  scope_key text not null,
  content_text text not null,
  reason text,
  source_message_ids_json text not null default '[]',
  sensitivity text not null,
  status text not null default 'pending',
  proposed_by text not null default 'model',
  decided_by_user_id text,
  decided_at integer,
  accepted_memory_id text,
  created_at integer not null,
  updated_at integer not null,
  foreign key (session_key) references session_routes(session_key),
  foreign key (accepted_memory_id) references session_memories(id)
);

create index if not exists idx_memory_candidates_session_status_created
  on memory_candidates(session_key, status, created_at);

create index if not exists idx_memory_candidates_scope_status
  on memory_candidates(scope, scope_key, status, updated_at);

create table if not exists attachment_records (
  id text primary key,
  session_key text not null,
  run_id text,
  telegram_message_id integer,
  kind text not null,
  file_id text not null,
  file_unique_id text,
  file_name text,
  mime_type text,
  file_size integer,
  ingestion_status text not null,
  ingestion_reason text,
  downloaded_bytes integer,
  extraction_kind text,
  extraction_status text,
  extraction_reason text,
  extracted_text_chars integer,
  prompt_text_chars integer,
  extraction_truncated integer,
  language text,
  row_count integer,
  column_count integer,
  page_count integer,
  created_at integer not null,
  updated_at integer not null,
  foreign key (session_key) references session_routes(session_key),
  foreign key (run_id) references runs(run_id)
);

create index if not exists idx_attachment_records_session_created
  on attachment_records(session_key, created_at);

create index if not exists idx_attachment_records_run
  on attachment_records(run_id);

create table if not exists telegram_user_roles (
  user_id text primary key,
  role text not null,
  granted_by_user_id text,
  reason text,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_telegram_user_roles_role
  on telegram_user_roles(role, updated_at);

create table if not exists telegram_chat_policies (
  chat_id text primary key,
  policy_json text not null,
  updated_by_user_id text,
  created_at integer not null,
  updated_at integer not null
);

create table if not exists telegram_governance_audit (
  id text primary key,
  actor_user_id text,
  target_user_id text,
  chat_id text,
  action text not null,
  role text,
  previous_role text,
  policy_json text,
  reason text,
  created_at integer not null
);

create index if not exists idx_telegram_governance_audit_created
  on telegram_governance_audit(created_at);

create index if not exists idx_telegram_governance_audit_target
  on telegram_governance_audit(target_user_id, created_at);

create index if not exists idx_telegram_governance_audit_chat
  on telegram_governance_audit(chat_id, created_at);

create table if not exists app_instance_leases (
  lease_name text primary key,
  owner_id text not null,
  expires_at integer not null,
  updated_at integer not null
);
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
