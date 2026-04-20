alter table session_routes
  add column agent_id text not null default 'main';
