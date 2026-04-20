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
