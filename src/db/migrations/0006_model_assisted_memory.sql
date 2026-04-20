alter table session_memories
  add column scope text not null default 'session';

alter table session_memories
  add column scope_key text not null default '';

alter table session_memories
  add column pinned integer not null default 0;

alter table session_memories
  add column archived_at integer;

alter table session_memories
  add column source_candidate_id text;

update session_memories
set scope_key = session_key
where scope_key = '';

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
