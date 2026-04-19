create table if not exists tool_approvals (
  id text primary key,
  session_key text not null,
  tool_name text not null,
  approved_by_user_id text not null,
  reason text not null,
  approved_at integer not null,
  expires_at integer not null,
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
  created_at integer not null,
  foreign key (session_key) references session_routes(session_key),
  foreign key (run_id) references runs(run_id)
);

create index if not exists idx_tool_approval_audit_session_created
  on tool_approval_audit(session_key, created_at);

create table if not exists session_memories (
  id text primary key,
  session_key text not null,
  content_text text not null,
  created_at integer not null,
  updated_at integer not null,
  foreign key (session_key) references session_routes(session_key)
);

create index if not exists idx_session_memories_session_created
  on session_memories(session_key, created_at);

create table if not exists app_instance_leases (
  lease_name text primary key,
  owner_id text not null,
  expires_at integer not null,
  updated_at integer not null
);
