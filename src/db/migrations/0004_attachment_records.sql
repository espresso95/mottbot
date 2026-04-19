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
