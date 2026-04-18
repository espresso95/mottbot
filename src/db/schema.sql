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

create table if not exists memory_vectors (
  message_id text primary key,
  session_key text not null,
  role text not null,
  content_text text not null,
  embedding_json text not null,
  created_at integer not null,
  foreign key (message_id) references messages(id) on delete cascade,
  foreign key (session_key) references session_routes(session_key) on delete cascade
);

create index if not exists idx_memory_vectors_session_created
  on memory_vectors(session_key, created_at);

create table if not exists runs (
  run_id text primary key,
  session_key text not null,
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
