alter table runs
  add column agent_id text not null default 'main';

create index if not exists idx_runs_agent_status_created
  on runs(agent_id, status, created_at);
