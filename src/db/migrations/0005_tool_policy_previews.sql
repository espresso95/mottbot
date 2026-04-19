alter table tool_approvals
  add column request_fingerprint text;

alter table tool_approvals
  add column preview_text text;

alter table tool_approval_audit
  add column request_fingerprint text;

alter table tool_approval_audit
  add column preview_text text;

create index if not exists idx_tool_approval_audit_pending
  on tool_approval_audit(session_key, tool_name, decision_code, requested_at);
