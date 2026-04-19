alter table session_memories
  add column source text not null default 'explicit';

create index if not exists idx_session_memories_session_source
  on session_memories(session_key, source, updated_at);
